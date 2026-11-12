import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../core/types.js';
import { createToolExecutor } from '../tools/index.js';

describe('local tools and permission enforcement', () => {
  let directory: string, workspace: string, context: ToolContext;
  const executor = createToolExecutor();
  const run = (name: string, args: Record<string, unknown>) => executor.execute({ id: 'tool-1', name, arguments: args }, context);
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'elvion-tools-')); workspace = path.join(directory, '中文 工作区'); await mkdir(workspace);
    context = { cwd: workspace, workspace, permission: 'ask', signal: new AbortController().signal, approve: vi.fn(async () => true), ask: vi.fn(async () => '用户答复'), onOutput: vi.fn(), setTodos: vi.fn(), secrets: ['secret-test-value'], sessionDir: directory };
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it('exposes eleven validated, serializable tool schemas', () => { expect(executor.definitions).toHaveLength(11); expect(JSON.stringify(executor.definitions)).toContain('apply_patch'); });
  it('rejects malformed, unknown and extra arguments', async () => { expect((await run('write_file', { path: 'a', content: 'a', extra: 'x' })).isError).toBe(true); expect((await run('unknown', {})).isError).toBe(true); expect((await run('read_file', { path: '\0' })).isError).toBe(true); });
  it('asks before writes, refuses without changing a file, reads automatically', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'hello'); context.approve = vi.fn(async () => false);
    const denied = await run('write_file', { path: 'a.txt', content: 'new' }); expect(denied.metadata?.status).toBe('rejected'); expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('hello');
    expect((await run('read_file', { path: 'a.txt' })).content).toBe('1: hello'); expect(context.approve).toHaveBeenCalledTimes(1);
  });
  it('auto-edit mode writes inside workspace without approval and atomically edits unique matches', async () => {
    context.permission = 'edit'; expect((await run('write_file', { path: 'sub/文件.txt', content: 'one two' })).isError).not.toBe(true);
    expect((await run('edit_file', { path: 'sub/文件.txt', old_text: 'two', new_text: 'three' })).isError).not.toBe(true);
    expect(await readFile(path.join(workspace, 'sub/文件.txt'), 'utf8')).toBe('one three'); expect(context.approve).not.toHaveBeenCalled();
    await writeFile(path.join(workspace, 'repeat'), 'aa aa'); expect((await run('edit_file', { path: 'repeat', old_text: 'aa', new_text: 'bb' })).isError).toBe(true);
  });
  it('detects concurrent changes during confirmation', async () => {
    await writeFile(path.join(workspace, 'a'), 'before'); context.approve = vi.fn(async () => { await writeFile(path.join(workspace, 'a'), 'changed'); return true; });
    expect((await run('write_file', { path: 'a', content: 'after' })).isError).toBe(true); expect(await readFile(path.join(workspace, 'a'), 'utf8')).toBe('changed');
  });
  it('preserves literal replacement metacharacters and rejects overlapping matches', async () => {
    context.permission = 'edit'; await writeFile(path.join(workspace, 'a'), 'before');
    await run('edit_file', { path: 'a', old_text: 'before', new_text: '$&-$`-$' + String.fromCharCode(39) });
    expect(await readFile(path.join(workspace, 'a'), 'utf8')).toBe('$&-$`-$' + String.fromCharCode(39));
    await writeFile(path.join(workspace, 'a'), 'aaa'); expect((await run('edit_file', { path: 'a', old_text: 'aa', new_text: 'b' })).isError).toBe(true);
  });
  it('asks before reading outside workspace, including directory junctions', async () => {
    const outside = path.join(directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret'), 'private');
    await symlink(outside, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); context.approve = vi.fn(async () => false);
    expect((await run('read_file', { path: 'link/secret' })).metadata?.status).toBe('rejected'); expect(context.approve).toHaveBeenCalledOnce();
  });
  it('rejects commands without starting Bash when approval is denied, including wrappers', async () => {
    context.permission = 'edit'; context.approve = vi.fn(async () => false);
    for (const [name, args] of [['bash', { command: 'touch dangerous' }], ['git', { args: ['status'] }], ['diff', {}]] as const) expect((await run(name, args)).metadata?.status).toBe('rejected');
    expect(context.approve).toHaveBeenCalledTimes(3);
  });
  it('applies a multi-file patch only after all hunks validate', async () => {
    context.permission = 'edit'; await writeFile(path.join(workspace, 'one'), 'old\n'); await writeFile(path.join(workspace, 'two'), 'second\n');
    const patch = '--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-wrong\n+other\n';
    expect((await run('apply_patch', { patch })).isError).toBe(true); expect(await readFile(path.join(workspace, 'one'), 'utf8')).toBe('old\n');
    expect((await run('apply_patch', { patch: patch.replace('-wrong', '-second') })).isError).not.toBe(true); expect(await readFile(path.join(workspace, 'one'), 'utf8')).toBe('new\n');
  });
  it('rejects patch traversal and wildcard escape', async () => {
    context.permission = 'full'; const patch = '--- /dev/null\n+++ b/../escape\n@@ -0,0 +1 @@\n+bad\n'; expect((await run('apply_patch', { patch })).isError).toBe(true); expect((await run('glob', { pattern: '../*' })).isError).toBe(true);
  });
  it('does not treat binary or unsupported mode patches as an empty successful write', async () => {
    context.permission = 'full';
    for (const patch of ['diff --git a/a b/a\nnew file mode 100644\n--- /dev/null\n+++ b/a\n', 'GIT binary patch\nliteral 0\n', '--- a/a\n+++ b/a\n']) expect((await run('apply_patch', { patch })).isError).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('rejects Windows devices and alternate data streams', async () => {
    context.permission = 'full';
    for (const target of ['file.txt:secret', 'NUL', 'con.txt', '//?/C:/temp/file']) expect((await run('write_file', { path: target, content: 'bad' })).isError).toBe(true);
  });
  it('searches literal text, hides dotgit and does not traverse junctions', async () => {
    await writeFile(path.join(workspace, 'first.ts'), 'a.b\nAXB\n'); await mkdir(path.join(workspace, '.git')); await writeFile(path.join(workspace, '.git', 'config'), 'a.b');
    const result = await run('grep', { pattern: 'a.b' }); expect(result.content).toBe('first.ts:1:a.b'); expect((await run('glob', { pattern: '**/*' })).content).toBe('first.ts');
  });
  it('redacts secrets and terminal controls from read results and returns question cancellation', async () => {
    await writeFile(path.join(workspace, 'a'), 'secret-test-value\x1b[31mRED\x1b[0m'); expect((await run('read_file', { path: 'a' })).content).toBe('1: [REDACTED]RED');
    context.ask = vi.fn(async () => null); expect((await run('ask_user_question', { question: '继续吗？' })).metadata?.status).toBe('cancelled');
  });
  it('updates only session todos and obeys an already cancelled signal', async () => {
    await run('todo', { items: [{ text: '验收', status: 'in_progress' }] }); expect(context.setTodos).toHaveBeenCalledWith([{ text: '验收', status: 'in_progress' }]);
    context.signal = AbortSignal.abort(); expect((await run('write_file', { path: 'a', content: 'x' })).metadata?.status).toBe('cancelled');
  });
});
