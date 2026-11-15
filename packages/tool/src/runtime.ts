import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, relative } from 'node:path';
import { z } from 'zod';
import { ElvionError, PermissionModeSchema, ToolCallSchema, serializeError, type ApprovalHandler, type ApprovalRequest, type JsonValue, type PermissionMode, type ToolCall, type ToolDescriptor, type ToolResult } from '@elvion/kernel';
import { descriptors, inputSchemas, type Inputs, type ToolName } from './schemas.js';
import { canonicalPath, resolvePath, assertWritablePath, pathExists } from './paths.js';
import { atomicWrite, hash, readText, walkFiles, type ChangeRecord } from './files.js';
import { parsePatch, applyHunks, type PatchTarget } from './patch.js';
import { executeGit, git, GitOwnership } from './git.js';
import { findGitBash, runProcess, type ProcessOptions } from './process.js';
import { boundedOutput, createRedactor } from './redact.js';

export interface ToolContext { workspace: string; permissionMode: PermissionMode; signal: AbortSignal; approve?: ApprovalHandler }
export interface AuditRecord { id: string; toolCallId: string; tool: string; phase: 'started' | 'finished'; timestamp: string; status?: ToolResult['status']; durationMs?: number; scope: string[] }
export interface ToolRuntimeOptions { bashPath?: string; maxOutputChars?: number; maxFileBytes?: number; audit?: (record: AuditRecord) => void | Promise<void> }
interface Prepared { workspace: string; paths: string[]; cwd: string; outside: boolean; patches?: PatchTarget[] }
interface TodoItem { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }
interface Outcome { output: JsonValue; truncated?: boolean }

export class ToolRuntime {
  private readonly maxOutputChars: number;
  private readonly maxFileBytes: number;
  private readonly ownership = new GitOwnership();
  private readonly todos = new Map<string, Map<string, TodoItem>>();
  private readonly auditRecords: AuditRecord[] = [];
  private pending = Promise.resolve();
  constructor(private readonly options: ToolRuntimeOptions = {}) {
    this.maxOutputChars = z.number().int().min(256).max(2_000_000).parse(options.maxOutputChars ?? 32_000);
    this.maxFileBytes = z.number().int().min(1).max(10_000_000).parse(options.maxFileBytes ?? 2_000_000);
  }
  descriptors(): ToolDescriptor[] { return descriptors(); }
  auditLog(): readonly AuditRecord[] { return this.auditRecords.map(record => ({ ...record, scope: [...record.scope] })); }
  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const previous = this.pending; let release = (): void => {};
    this.pending = new Promise<void>(done => { release = done; });
    await previous;
    try { return await this.executeOne(call, context); } finally { release(); }
  }
  private async audit(record: AuditRecord): Promise<void> {
    this.auditRecords.push(record);
    if (this.auditRecords.length > 2_000) this.auditRecords.splice(0, this.auditRecords.length - 2_000);
    await this.options.audit?.(record);
  }
  private assertActive(signal: AbortSignal): void { if (signal.aborted) throw new ElvionError('cancelled', 'Tool call was cancelled'); }
  private processOptions(prepared: Prepared, context: ToolContext, timeoutMs = 120_000): ProcessOptions { return { cwd: prepared.cwd, signal: context.signal, timeoutMs, maxOutputChars: this.maxOutputChars }; }
  private async prepare(name: ToolName, input: Record<string, unknown>, context: ToolContext): Promise<Prepared> {
    if (!isAbsolute(context.workspace)) throw new ElvionError('validation_error', 'Workspace must be an absolute path');
    const workspace = await canonicalPath(resolve(context.workspace));
    if (!(await stat(workspace)).isDirectory()) throw new ElvionError('validation_error', 'Workspace must be an existing directory');
    const cwd = typeof input['cwd'] === 'string' ? await resolvePath(workspace, input['cwd']) : { path: workspace, outside: false };
    const rawPaths = typeof input['path'] === 'string' ? [input['path']] : Array.isArray(input['paths']) ? input['paths'] as string[] : [];
    const patches = name === 'apply_patch' ? parsePatch(input['patch'] as string) : undefined;
    if (patches) rawPaths.push(...patches.map(target => target.path));
    const paths = await Promise.all(rawPaths.map(path => resolvePath(typeof input['cwd'] === 'string' ? cwd.path : workspace, path)));
    if (['write_file', 'edit_file', 'apply_patch'].includes(name)) for (const path of paths) assertWritablePath(workspace, path.path);
    if (new Set(paths.map(path => path.path.toLowerCase())).size !== paths.length) throw new ElvionError('validation_error', 'Duplicate or aliased paths in one call are unsupported');
    return { workspace, paths: paths.map(path => path.path), cwd: cwd.path, outside: cwd.outside || paths.some(path => path.outside), ...(patches ? { patches } : {}) };
  }
  private async executeOne(rawCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const started = performance.now(); const auditId = randomUUID(); let scope = [context.workspace];
    const base = (): { toolCallId: string; durationMs: number; truncated: boolean } => ({ toolCallId: typeof rawCall?.id === 'string' && rawCall.id ? rawCall.id : 'invalid-call', durationMs: performance.now() - started, truncated: false });
    let result: ToolResult;
    try {
      this.assertActive(context.signal);
      const call = ToolCallSchema.parse(rawCall); PermissionModeSchema.parse(context.permissionMode);
      if (!Object.hasOwn(inputSchemas, call.name)) throw new ElvionError('not_found', 'Unknown tool');
      const name = call.name as ToolName;
      const input = inputSchemas[name].parse(call.arguments) as Record<string, unknown>;
      const prepared = await this.prepare(name, input, context); scope = prepared.paths.length ? prepared.paths : [prepared.cwd];
      await this.audit({ id: auditId, toolCallId: call.id, tool: call.name, phase: 'started', timestamp: new Date().toISOString(), scope });
      const requiresApproval = context.permissionMode === 'ask' || (context.permissionMode === 'auto-edit' && (prepared.outside || name === 'bash' || (name === 'git' && ['init', 'add', 'commit'].includes(String(input['operation'])))));
      if (requiresApproval) {
        const approval: ApprovalRequest = { id: randomUUID(), toolCall: call, workspace: prepared.workspace, cwd: prepared.cwd, summary: createRedactor()(`${name}: ${JSON.stringify(call.arguments).slice(0, 1_000)}`), scope };
        if (!context.approve) result = { ...base(), status: 'approval_required', approval };
        else {
          const decision = await this.awaitApproval(context.approve, approval, context.signal);
          if (decision.requestId !== approval.id) throw new ElvionError('permission_denied', 'Approval response does not match this tool call');
          if (decision.decision !== 'approved') throw new ElvionError(decision.decision === 'cancelled' ? 'cancelled' : 'permission_denied', 'The user did not approve this tool call');
          result = await this.runApproved(name, input, prepared, context, base);
        }
      } else result = await this.runApproved(name, input, prepared, context, base);
    } catch (error) {
      const failure = error instanceof z.ZodError ? new ElvionError('validation_error', 'Tool input did not match its schema', { details: { issues: error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message })) } }) : error instanceof ElvionError ? error : new ElvionError('tool_error', 'Tool operation failed', { cause: error });
      result = { ...base(), status: failure.code === 'cancelled' ? 'cancelled' : failure.code === 'permission_denied' ? 'denied' : 'error', error: serializeError(failure) };
    }
    await this.audit({ id: auditId, toolCallId: result.toolCallId, tool: rawCall?.name ?? 'invalid', phase: 'finished', timestamp: new Date().toISOString(), scope, status: result.status, durationMs: result.durationMs });
    return result;
  }
  private async awaitApproval(handler: ApprovalHandler, request: ApprovalRequest, signal: AbortSignal): ReturnType<ApprovalHandler> {
    return await new Promise((resolve, reject) => {
      const onAbort = (): void => reject(new ElvionError('cancelled', 'Approval was cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      handler(request, { signal }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    });
  }
  private async runApproved(name: ToolName, input: Record<string, unknown>, prepared: Prepared, context: ToolContext, base: () => { toolCallId: string; durationMs: number; truncated: boolean }): Promise<ToolResult> {
    this.assertActive(context.signal);
    for (const path of [...prepared.paths, prepared.cwd]) if (await canonicalPath(path) !== path) throw new ElvionError('conflict', 'A path changed after authorization');
    const outcome = await this.perform(name, input, prepared, context);
    const bounded = boundedOutput(outcome.output, this.maxOutputChars);
    return { ...base(), status: 'success', output: bounded.value, truncated: Boolean(outcome.truncated) || bounded.truncated };
  }
  private async perform(name: ToolName, input: Record<string, unknown>, prepared: Prepared, context: ToolContext): Promise<Outcome> {
    const path = prepared.paths[0]!;
    switch (name) {
      case 'read_file': {
        const args = input as Inputs<'read_file'>; const text = await readText(path, this.maxFileBytes);
        const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop();
        const start = args.startLine ?? 1; const end = args.endLine ?? lines.length;
        return { output: { path, content: args.startLine === undefined && args.endLine === undefined ? text : lines.slice(start - 1, end).join('\n'), startLine: start, endLine: Math.min(end, lines.length), totalLines: lines.length, hash: hash(text) } };
      }
      case 'write_file': {
        const args = input as Inputs<'write_file'>; const exists = await pathExists(path);
        if (Buffer.byteLength(args.content, 'utf8') > this.maxFileBytes) throw new ElvionError('validation_error', 'New file content exceeds the configured file limit');
        if (exists && !args.overwrite) throw new ElvionError('conflict', 'File exists; overwrite must be explicitly enabled');
        const before = exists ? await readText(path, this.maxFileBytes) : null;
        if (args.expectedHash && (before === null || hash(before) !== args.expectedHash)) throw new ElvionError('conflict', 'File no longer matches expectedHash');
        await this.ownership.capture(path, this.processOptions(prepared, context)); this.assertActive(context.signal);
        const change = await atomicWrite(path, args.content, before === null ? null : hash(before));
        this.ownership.record(path, change.afterHash);
        return { output: { changeRecords: [this.changeJson(change)] } };
      }
      case 'edit_file': {
        const args = input as Inputs<'edit_file'>; const before = await readText(path, this.maxFileBytes);
        if (args.expectedHash && hash(before) !== args.expectedHash) throw new ElvionError('conflict', 'File no longer matches expectedHash');
        const matches = before.split(args.oldText).length - 1;
        if (matches !== args.expectedMatches) throw new ElvionError('conflict', `Exact edit expected ${args.expectedMatches} matches but found ${matches}`);
        await this.ownership.capture(path, this.processOptions(prepared, context)); this.assertActive(context.signal);
        const updated = before.split(args.oldText).join(args.newText);
        if (Buffer.byteLength(updated, 'utf8') > this.maxFileBytes) throw new ElvionError('validation_error', 'Updated content exceeds the configured file limit');
        const change = await atomicWrite(path, updated, hash(before));
        this.ownership.record(path, change.afterHash);
        return { output: { matches, changeRecords: [this.changeJson(change)] } };
      }
      case 'glob': {
        const args = input as Inputs<'glob'>; const files = await walkFiles(path, { ...args, signal: context.signal });
        return { output: { files: files.slice(0, args.maxResults).map(file => relative(path, file).replaceAll('\\', '/')) }, truncated: files.length > args.maxResults };
      }
      case 'grep': return this.grep(input as Inputs<'grep'>, path, prepared, context);
      case 'bash': {
        const args = input as Inputs<'bash'>;
        const marker = `__ELVION_BASH_READY_${randomUUID().replaceAll('-', '')}__`;
        const output = await runProcess(await findGitBash(this.options.bashPath), ['--noprofile', '--norc', '-c', `printf '%s' '${marker}' >&2\n${args.command}`], { ...this.processOptions(prepared, context, args.timeoutMs), readyMarker: marker });
        return { output: { ...output }, truncated: output.truncated };
      }
      case 'git': { const args = input as Inputs<'git'>; const output = await executeGit(args, prepared.paths, this.ownership, this.processOptions(prepared, context, args.timeoutMs)); return { output: { ...output }, truncated: output.truncated }; }
      case 'diff': { const args = input as Inputs<'diff'>; const output = await git(['diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : []), '--', ...prepared.paths], this.processOptions(prepared, context)); return { output: { ...output }, truncated: output.truncated }; }
      case 'apply_patch': return this.patch(prepared, context);
      case 'todo': return this.todo(input as Inputs<'todo'>, prepared.workspace);
    }
  }
  private changeJson(change: ChangeRecord): { path: string; beforeHash: string | null; afterHash: string | null; kind: string } { return { ...change }; }
  private todo(args: Inputs<'todo'>, workspace: string): Outcome {
    let items = this.todos.get(workspace); if (!items) { items = new Map(); this.todos.set(workspace, items); }
    if (args.operation === 'add') {
      if (!args.text) throw new ElvionError('validation_error', 'Adding a todo requires text');
      const id = args.id ?? randomUUID(); if (items.has(id)) throw new ElvionError('conflict', 'Todo ID already exists');
      items.set(id, { id, text: args.text, status: args.status ?? 'pending' });
    } else if (args.operation === 'update' || args.operation === 'remove') {
      const item = args.id ? items.get(args.id) : undefined; if (!item) throw new ElvionError('not_found', 'Todo item does not exist');
      if (args.operation === 'remove') items.delete(item.id); else { if (args.text) item.text = args.text; if (args.status) item.status = args.status; }
    }
    return { output: { items: [...items.values()].map(item => ({ ...item })) } };
  }
  private async grep(args: Inputs<'grep'>, path: string, prepared: Prepared, context: ToolContext): Promise<Outcome> {
    const files = (await stat(path)).isFile() ? [path] : await walkFiles(path, { pattern: args.filePattern, exclude: args.exclude, signal: context.signal });
    const matches: { path: string; line: number; text: string }[] = []; let truncated = false;
    for (const file of files) {
      this.assertActive(context.signal); if (matches.length >= args.maxResults) { truncated = true; break; }
      if (args.regex) {
        const result = await git(['grep', '--no-index', '--no-recurse-submodules', '-n', '-I', '-E', ...(args.caseSensitive ? [] : ['-i']), '-e', args.pattern, '--', basename(file)], { ...this.processOptions(prepared, context, 10_000), cwd: dirname(file) });
        if (result.exitCode > 1) throw new ElvionError('validation_error', 'Regex search failed; use a valid Git extended regular expression');
        for (const line of result.stdout.split('\n').filter(Boolean)) {
          const data = /^(.*?):(\d+):(.*)$/.exec(line); if (data) matches.push({ path: file, line: Number(data[2]), text: data[3] ?? '' });
          if (matches.length >= args.maxResults) { truncated = true; break; }
        }
        truncated ||= result.truncated;
      } else {
        let content: string; try { content = await readText(file, this.maxFileBytes); } catch (error) { if (error instanceof ElvionError && error.code === 'validation_error') continue; throw error; }
        const needle = args.caseSensitive ? args.pattern : args.pattern.toLocaleLowerCase();
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? ''; if ((args.caseSensitive ? line : line.toLocaleLowerCase()).includes(needle)) matches.push({ path: file, line: index + 1, text: line.replace(/\r$/, '') });
          if (matches.length >= args.maxResults) { truncated = true; break; }
        }
      }
    }
    return { output: { matches }, truncated };
  }
  private async patch(prepared: Prepared, context: ToolContext): Promise<Outcome> {
    const plan: { path: string; before: string | null; after: string | null }[] = [];
    for (let index = 0; index < prepared.paths.length; index++) {
      const path = prepared.paths[index]!; const target = prepared.patches![index]!;
      const exists = await pathExists(path);
      if (target.create === exists) throw new ElvionError('conflict', target.create ? 'Patch creation target already exists' : 'Patch target does not exist');
      const before = exists ? await readText(path, this.maxFileBytes) : null;
      const after = applyHunks(before ?? '', target);
      if (Buffer.byteLength(after, 'utf8') > this.maxFileBytes) throw new ElvionError('validation_error', 'Patched content exceeds the configured file limit');
      plan.push({ path, before, after: target.delete ? null : after });
    }
    for (const item of plan) await this.ownership.capture(item.path, this.processOptions(prepared, context));
    const changed: ChangeRecord[] = [];
    try {
      for (const item of plan) {
        this.assertActive(context.signal);
        if (await canonicalPath(item.path) !== item.path) throw new ElvionError('conflict', 'Patch target path changed');
        if (item.after === null) {
          if (hash(await readFile(item.path)) !== hash(item.before!)) throw new ElvionError('conflict', 'Patch target changed during execution');
          await rm(item.path); changed.push({ path: item.path, kind: 'deleted', beforeHash: hash(item.before!), afterHash: null });
        } else changed.push(await atomicWrite(item.path, item.after, item.before === null ? null : hash(item.before)));
      }
    } catch (cause) {
      const rollbackFailures: string[] = [];
      for (const change of [...changed].reverse()) {
        const original = plan.find(item => item.path === change.path)!;
        try {
          const current = await pathExists(change.path) ? hash(await readFile(change.path)) : null;
          if (current !== change.afterHash) throw new ElvionError('conflict', 'Cannot roll back a concurrently changed file');
          if (original.before === null) await rm(change.path); else await atomicWrite(change.path, original.before, current);
        } catch { rollbackFailures.push(change.path); }
      }
      if (rollbackFailures.length) throw new ElvionError('conflict', 'Patch failed and some files could not be rolled back; manual review required', { cause, details: { requiresReview: true, rollbackFailures, changedFiles: changed.map(item => item.path) } });
      throw cause;
    }
    for (const change of changed) this.ownership.record(change.path, change.afterHash);
    return { output: { changeRecords: changed.map(change => this.changeJson(change)) } };
  }
}
