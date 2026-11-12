import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { applyPatch, createTwoFilesPatch, parsePatch } from 'diff';
import { z } from 'zod';
import type { ToolCall, ToolContext, ToolDefinition, ToolExecutor, ToolResult } from '../core/types.js';
import { quoteBashArgument, runBash } from '../execution/bash.js';
import { safeText } from '../execution/sanitize.js';

const MAX_READ = 2 * 1024 * 1024;
const filePath = z.string().min(1).max(4096).refine(value => !value.includes('\0'), '路径不能包含 NUL');
const cwd = filePath.optional();
const schemas = {
  bash: z.object({ command: z.string().min(1).max(100000), cwd, timeout_ms: z.number().int().min(1).max(600000).default(120000), max_output_bytes: z.number().int().min(1024).max(4194304).default(1048576) }).strict(),
  read_file: z.object({ path: filePath, start_line: z.number().int().min(1).default(1), end_line: z.number().int().min(1).optional() }).strict(),
  write_file: z.object({ path: filePath, content: z.string().max(MAX_READ) }).strict(),
  edit_file: z.object({ path: filePath, old_text: z.string().min(1).max(MAX_READ), new_text: z.string().max(MAX_READ) }).strict(),
  grep: z.object({ pattern: z.string().min(1).max(4096), path: cwd, glob: z.string().max(256).default('**/*'), case_sensitive: z.boolean().default(true), limit: z.number().int().min(1).max(1000).default(200) }).strict(),
  glob: z.object({ pattern: z.string().min(1).max(256), path: cwd, limit: z.number().int().min(1).max(1000).default(200) }).strict(),
  git: z.object({ args: z.array(z.string().max(20000)).min(1).max(100), cwd, timeout_ms: z.number().int().min(1).max(600000).default(120000) }).strict(),
  diff: z.object({ cwd, staged: z.boolean().default(false), paths: z.array(filePath).max(100).default([]) }).strict(),
  apply_patch: z.object({ patch: z.string().min(1).max(MAX_READ) }).strict(),
  todo: z.object({ items: z.array(z.object({ text: z.string().min(1).max(2000), status: z.enum(['pending', 'in_progress', 'completed']) }).strict()).max(100) }).strict(),
  ask_user_question: z.object({ question: z.string().min(1).max(10000), options: z.array(z.string().min(1).max(1000)).min(2).max(8).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  bash: '通过唯一 Bash 执行非交互命令。独立 cwd，不保留上条命令的 cd；有超时与输出上限。',
  read_file: '按行读取 UTF-8 文件（最多 2 MiB），返回行号。',
  write_file: '原子写入完整 UTF-8 文件，覆盖前展示变更并检查权限。',
  edit_file: '精确替换文件中唯一 old_text；不存在或多处匹配则拒绝。',
  grep: '在目录文件中进行字面量文本搜索（非正则），返回路径、行号和内容。',
  glob: '在目录内按 glob 查找文件，不跟随目录符号链接，限制结果数量。',
  git: '通过同一 Bash 执行 Git 参数数组，所有 Git 命令遵守命令确认。',
  diff: '通过 Bash 查看 Git 工作区或暂存区 diff；遵守命令确认。',
  apply_patch: '原子批次应用 unified diff；拒绝二进制、重命名、越界相对路径与不匹配的 hunk。',
  todo: '替换当前会话的任务清单，不建立跨会话记忆。',
  ask_user_question: '向用户显示问题和可选答案；用户可自由输入或取消。',
};
export const toolDefinitions: ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], parameters: z.toJSONSchema(schema) as Record<string, unknown> }));

async function resolveTarget(input: string, base: string): Promise<string> {
  if (process.platform === 'win32') {
    if (/^(?:\\\\[?.]\\|\\\?\\)/.test(input)) throw new Error('不支持 Windows 设备路径。');
    const relative = input.replace(/^[A-Za-z]:/, '');
    if (relative.includes(':')) throw new Error('不支持 Windows 备用数据流路径。');
    if (relative.split(/[\\/]/).some(segment => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) throw new Error('不支持 Windows 保留设备名。');
  }
  let target = path.resolve(base, input);
  const rest: string[] = [];
  for (;;) {
    try { target = await realpath(target); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(target); if (parent === target) throw error;
      rest.unshift(path.basename(target)); target = parent;
    }
  }
  return path.join(target, ...rest);
}
function within(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
async function allowed(context: ToolContext, call: ToolCall, paths: string[], write: boolean, shell: boolean, details: string): Promise<void> {
  context.signal.throwIfAborted();
  const root = await realpath(context.workspace);
  const outside = paths.some(target => !within(root, target));
  if (context.permission !== 'full' && (shell || (write && context.permission === 'ask') || outside)) {
    const accepted = await context.approve({ id: call.id, tool: call.name, title: shell ? '执行命令' : write ? '修改文件' : '访问工作区外文件', details: safeText(details, context.secrets), paths });
    context.signal.throwIfAborted();
    if (!accepted) throw new ToolFailure('用户已拒绝本次操作。', 'rejected');
  }
  context.signal.throwIfAborted();
}
class ToolFailure extends Error { constructor(message: string, readonly status = 'failed') { super(message); } }
async function textFile(target: string): Promise<string> { const info = await stat(target); if (!info.isFile()) throw new Error('目标不是普通文件。'); if (info.size > MAX_READ) throw new Error('文件超过 2 MiB 上限，请缩小范围或通过 Bash 使用专用工具。'); const data = await readFile(target); if (data.includes(0)) throw new Error('不支持二进制文件。'); return data.toString('utf8'); }
async function existingText(target: string): Promise<string | undefined> { try { return await textFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.elvion-${randomUUID()}.tmp`);
  try {
    const mode = await stat(target).then(info => info.mode).catch(() => 0o600);
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' }); await rename(temp, target);
  } finally { await unlink(temp).catch(() => undefined); }
}
function safeGlob(pattern: string): void { if (path.isAbsolute(pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(pattern) || pattern.includes('\0')) throw new Error('glob pattern 必须位于指定搜索目录内。'); }
async function files(pattern: string, directory: string, limit: number): Promise<string[]> {
  safeGlob(pattern);
  const result: string[] = [];
  const stream = fg.stream(pattern, { cwd: directory, dot: true, onlyFiles: true, followSymbolicLinks: false, ignore: ['**/.git/**', '**/node_modules/**'], unique: true });
  for await (const item of stream) { result.push(String(item)); if (result.length >= limit) break; }
  return result.sort();
}
async function shellResult(call: ToolCall, context: ToolContext, command: string, directory: string, timeout: number, maxOutputBytes?: number): Promise<ToolResult> {
  await allowed(context, call, [directory], false, true, `命令：${command}\n工作目录：${directory}\n超时：${timeout} ms`);
  const result = await runBash({ command, cwd: directory, timeoutMs: timeout, maxOutputBytes, signal: context.signal, secrets: context.secrets, onOutput: context.onOutput });
  const status = result.cancelled ? 'cancelled' : result.timedOut ? 'timed_out' : result.exitCode ? 'failed' : 'completed';
  const suffix = result.truncated ? '\n[输出达到运行时上限，后续字节已丢弃]' : '';
  return { content: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}${suffix}\n[exit ${result.exitCode}${result.timedOut ? '；超时' : ''}${result.cancelled ? '；已取消' : ''}]`, isError: status !== 'completed', metadata: { ...result, status, command: safeText(command, context.secrets), cwd: directory } };
}

async function execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  if (!Object.hasOwn(schemas, call.name)) return { content: `未知工具：${safeText(call.name)}`, isError: true };
  try {
    context.signal.throwIfAborted();
    const base = await realpath(context.cwd);
    switch (call.name) {
      case 'bash': { const args = schemas.bash.parse(call.arguments); const directory = await resolveTarget(args.cwd ?? '.', base); return await shellResult(call, context, args.command, directory, args.timeout_ms, args.max_output_bytes); }
      case 'git': { const args = schemas.git.parse(call.arguments); const directory = await resolveTarget(args.cwd ?? '.', base); return await shellResult(call, context, `git ${args.args.map(quoteBashArgument).join(' ')}`, directory, args.timeout_ms); }
      case 'diff': { const args = schemas.diff.parse(call.arguments); const directory = await resolveTarget(args.cwd ?? '.', base); const argv = ['diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : []), '--', ...args.paths]; return await shellResult(call, context, `git ${argv.map(quoteBashArgument).join(' ')}`, directory, 120000); }
      case 'read_file': {
        const args = schemas.read_file.parse(call.arguments); const target = await resolveTarget(args.path, base);
        await allowed(context, call, [target], false, false, `读取：${target}`); const value = await textFile(target);
        const lines = value.split('\n'); const end = Math.min(args.end_line ?? lines.length, lines.length); if (end < args.start_line) throw new Error('end_line 必须不小于 start_line。');
        return { content: safeText(lines.slice(args.start_line - 1, end).map((line, i) => `${args.start_line + i}: ${line}`).join('\n'), context.secrets), metadata: { path: target, totalLines: lines.length } };
      }
      case 'write_file':
      case 'edit_file': {
        const args = call.name === 'write_file' ? schemas.write_file.parse(call.arguments) : schemas.edit_file.parse(call.arguments);
        const target = await resolveTarget(args.path, base);
        await allowed(context, call, [target], false, false, `读取待修改文件以计算变更：${target}`);
        const original = await existingText(target);
        let next: string;
        if ('content' in args) next = args.content; else {
          if (original === undefined) throw new Error('待编辑文件不存在。');
          const start = original.indexOf(args.old_text);
          if (start < 0 || original.indexOf(args.old_text, start + 1) >= 0) throw new Error('old_text 必须唯一匹配。');
          next = original.slice(0, start) + args.new_text + original.slice(start + args.old_text.length);
        }
        const diff = createTwoFilesPatch(target, target, original ?? '', next);
        await allowed(context, call, [target], true, false, diff);
        if (await existingText(target) !== original || await resolveTarget(args.path, base) !== target) throw new Error('文件在确认期间发生变化，请重新读取。');
        await atomicWrite(target, next); return { content: safeText(diff, context.secrets), metadata: { path: target, status: 'completed' } };
      }
      case 'glob': { const args = schemas.glob.parse(call.arguments); const directory = await resolveTarget(args.path ?? '.', base); await allowed(context, call, [directory], false, false, `查找：${directory}\n模式：${args.pattern}`); return { content: safeText((await files(args.pattern, directory, args.limit)).join('\n'), context.secrets) }; }
      case 'grep': {
        const args = schemas.grep.parse(call.arguments); const directory = await resolveTarget(args.path ?? '.', base);
        await allowed(context, call, [directory], false, false, `搜索：${directory}\n文本：${args.pattern}`);
        const matches: string[] = []; const names = await files(args.glob, directory, 10000); const needle = args.case_sensitive ? args.pattern : args.pattern.toLocaleLowerCase();
        outer: for (const name of names) {
          context.signal.throwIfAborted(); const target = path.join(directory, name); const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) continue;
          const resolved = await realpath(target); if (!within(directory, resolved)) continue;
          let value: string; try { value = await textFile(resolved); } catch { continue; }
          const lines = value.split('\n'); for (let i = 0; i < lines.length; i++) if ((args.case_sensitive ? lines[i]! : lines[i]!.toLocaleLowerCase()).includes(needle)) { matches.push(`${name}:${i + 1}:${lines[i]!.slice(0, 4000)}`); if (matches.length >= args.limit) break outer; }
        }
        return { content: safeText(matches.join('\n'), context.secrets), metadata: { limited: matches.length >= args.limit || names.length >= 10000 } };
      }
      case 'apply_patch': {
        const args = schemas.apply_patch.parse(call.arguments);
        if (/^(?:GIT binary patch|Binary files |rename from |rename to |copy from |copy to |old mode |new mode |deleted file mode |new file mode )/m.test(args.patch)) throw new Error('首版只支持文本内容补丁，不支持二进制、重命名、复制或权限变更。');
        const parsed = parsePatch(args.patch); if (!parsed.length || parsed.length > 100) throw new Error('补丁必须包含 1～100 个文件。');
        const changes: { target: string; original?: string; next?: string; input: string }[] = [];
        for (const patch of parsed) {
          const oldName = patch.oldFileName, newName = patch.newFileName; if (!oldName || !newName || !patch.hunks.length) throw new Error('补丁缺少文件名或文本 hunk。');
          const oldInput = oldName === '/dev/null' ? undefined : oldName.replace(/^a\//, ''); const newInput = newName === '/dev/null' ? undefined : newName.replace(/^b\//, '');
          if (oldInput && newInput && oldInput !== newInput) throw new Error('首版不支持补丁重命名，请分别创建和删除。');
          const input = newInput ?? oldInput!; safeGlob(input); const target = await resolveTarget(input, base);
          await allowed(context, call, [target], false, false, `读取补丁目标以计算变更：${target}`);
          if (changes.some(change => process.platform === 'win32' ? change.target.toLocaleLowerCase() === target.toLocaleLowerCase() : change.target === target)) throw new Error('补丁包含重复目标文件。');
          const original = await existingText(target); if (!oldInput && original !== undefined) throw new Error('新增目标已存在。'); if (oldInput && original === undefined) throw new Error('待修改目标不存在。');
          const next = applyPatch(original ?? '', patch, { fuzzFactor: 0 }); if (next === false) throw new Error(`补丁与文件不匹配：${input}`);
          if (!newInput && next !== '') throw new Error(`删除补丁必须移除文件全部内容：${input}`);
          if (Buffer.byteLength(next) > MAX_READ) throw new Error('补丁结果超过文件大小上限。');
          changes.push({ input, target, original, next: newInput ? next : undefined });
        }
        await allowed(context, call, changes.map(change => change.target), true, false, args.patch);
        for (const change of changes) if (await existingText(change.target) !== change.original || await resolveTarget(change.input, base) !== change.target) throw new Error('确认期间文件发生变化。');
        const completed: typeof changes = [];
        try {
          for (const change of changes) { context.signal.throwIfAborted(); if (change.next === undefined) await unlink(change.target); else await atomicWrite(change.target, change.next); completed.push(change); }
        } catch (error) {
          const rollbackErrors: string[] = [];
          for (const change of completed.reverse()) { try { if (change.original === undefined) await unlink(change.target); else await atomicWrite(change.target, change.original); } catch { rollbackErrors.push(change.target); } }
          if (rollbackErrors.length) throw new Error(`补丁失败且部分回滚失败，必须人工核实：${rollbackErrors.join(', ')}`); throw error;
        }
        return { content: `已应用补丁：${changes.map(change => change.input).join(', ')}`, metadata: { paths: changes.map(change => change.target), status: 'completed' } };
      }
      case 'todo': { const args = schemas.todo.parse(call.arguments); context.setTodos(args.items); return { content: args.items.map(item => `${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]'} ${item.text}`).join('\n') }; }
      case 'ask_user_question': { const args = schemas.ask_user_question.parse(call.arguments); const answer = await context.ask({ id: call.id, question: args.question, options: args.options }); return answer === null ? { content: '用户取消了本次回答。', metadata: { status: 'cancelled' } } : { content: safeText(answer, context.secrets) }; }
    }
    throw new Error('未实现的工具。');
  } catch (error) {
    return { content: safeText(error instanceof Error ? error.message : String(error), context.secrets), isError: true, metadata: { status: context.signal.aborted ? 'cancelled' : error instanceof ToolFailure ? error.status : 'failed' } };
  }
}
export function createToolExecutor(): ToolExecutor { return { definitions: toolDefinitions, execute }; }
