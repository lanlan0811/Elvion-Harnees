import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolResultSchema, type JsonObject, type PermissionMode, type ToolCall, type ToolResult } from '@elvion/kernel';
import { ToolRuntime } from './runtime.js';
import { findGitBash } from './process.js';
import { applyHunks, parsePatch } from './patch.js';
import * as files from './files.js';

const exec = promisify(execFile);
let root: string; let workspace: string; let runtime: ToolRuntime;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'elvion-tools-')); workspace = join(root, '工作区'); await mkdir(workspace); runtime = new ToolRuntime(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const call = (name: string, args: JsonObject): ToolCall => ({ id: randomUUID(), name, arguments: args });
const execute = async (name: string, args: JsonObject, mode: PermissionMode = 'auto-edit'): Promise<ToolResult> => {
  const result = await runtime.execute(call(name, args), { workspace, permissionMode: mode, signal: new AbortController().signal });
  expect(ToolResultSchema.safeParse(result).success).toBe(true); return result;
};
function output(result: ToolResult): JsonObject { expect(result.status).toBe('success'); if (result.status !== 'success' || !result.output || Array.isArray(result.output) || typeof result.output !== 'object') throw new Error(JSON.stringify(result)); return result.output; }
async function git(...args: string[]): Promise<string> { return (await exec('git', args, { cwd: workspace, windowsHide: true })).stdout; }
async function initRepo(): Promise<void> { await git('init'); await git('config', 'user.name', 'Elvion Test'); await git('config', 'user.email', 'elvion-test@example.invalid'); }

describe('tool registry and file tools', () => {
  it('publishes exactly ten strict input schemas and rejects unknown fields before side effects', async () => {
    expect(runtime.descriptors().map(item => item.name).sort()).toEqual(['apply_patch', 'bash', 'diff', 'edit_file', 'git', 'glob', 'grep', 'read_file', 'todo', 'write_file']);
    expect((await execute('write_file', { path: 'bad.txt', content: 'x', permissions: 'full-access' })).status).toBe('error');
    expect((await execute('missing_tool', {})).status).toBe('error');
    await expect(stat(join(workspace, 'bad.txt'))).rejects.toThrow();
  });
  it('creates Chinese paths, reads exact UTF-8/CRLF, and enforces explicit overwrite and stale hashes', async () => {
    const created = output(await execute('write_file', { path: '目录/中文.txt', content: '第一行\r\n第二行\r\n' }));
    expect(created['changeRecords']).toHaveLength(1);
    const read = output(await execute('read_file', { path: '目录/中文.txt' }));
    expect(read['content']).toBe('第一行\r\n第二行\r\n');
    expect(output(await execute('read_file', { path: '目录/中文.txt', startLine: 2, endLine: 2 }))['content']).toBe('第二行\r');
    expect((await execute('write_file', { path: '目录/中文.txt', content: 'bad' })).status).toBe('error');
    expect((await execute('write_file', { path: '目录/中文.txt', content: 'bad', overwrite: true, expectedHash: '0'.repeat(64) })).status).toBe('error');
    expect(await readFile(join(workspace, '目录/中文.txt'), 'utf8')).toBe('第一行\r\n第二行\r\n');
    expect((await execute('write_file', { path: '目录/中文.txt', content: '更新', overwrite: true, expectedHash: read['hash']! })).status).toBe('success');
  });
  it('edits only an exact verified match count and preserves CRLF', async () => {
    await writeFile(join(workspace, 'a.txt'), 'old old\r\nkeep\r\n');
    expect((await execute('edit_file', { path: 'a.txt', oldText: 'old', newText: 'new' })).status).toBe('error');
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('old old\r\nkeep\r\n');
    expect((await execute('edit_file', { path: 'a.txt', oldText: 'old', newText: 'new', expectedMatches: 2 })).status).toBe('success');
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('new new\r\nkeep\r\n');
  });
  it('rejects oversized, binary, invalid UTF-8 and reverse line ranges', async () => {
    runtime = new ToolRuntime({ maxFileBytes: 8 });
    await writeFile(join(workspace, 'large'), '123456789'); await writeFile(join(workspace, 'bin'), Buffer.from([1, 0, 2])); await writeFile(join(workspace, 'utf'), Buffer.from([255, 254]));
    for (const path of ['large', 'bin', 'utf']) expect((await execute('read_file', { path })).status).toBe('error');
    expect((await execute('read_file', { path: 'large', startLine: 3, endLine: 2 })).status).toBe('error');
  });
  it('reads exact near-limit UTF-8/CRLF ranges and preserves BOM and empty-file semantics', async () => {
    const line = '中文范围' + 'x'.repeat(980) + '\r';
    const lineCount = Math.floor(1_999_999 / Buffer.byteLength(line + '\n'));
    const content = (line + '\n').repeat(lineCount);
    expect(Buffer.byteLength(content)).toBeGreaterThan(1_990_000);
    await writeFile(join(workspace, '接近上限.txt'), content);
    const range = await execute('read_file', { path: '接近上限.txt', startLine: lineCount - 1, endLine: lineCount });
    expect(range.truncated).toBe(false);
    expect(output(range)).toMatchObject({ content: line + '\n' + line, startLine: lineCount - 1, endLine: lineCount, totalLines: lineCount, hash: files.hash(content) });
    const beyond = output(await execute('read_file', { path: '接近上限.txt', startLine: lineCount + 1 }));
    expect(beyond).toMatchObject({ content: '', startLine: lineCount + 1, endLine: lineCount, totalLines: lineCount });
    await writeFile(join(workspace, 'empty.txt'), '');
    expect(output(await execute('read_file', { path: 'empty.txt' }))).toMatchObject({ content: '', startLine: 1, endLine: 1, totalLines: 1, hash: files.hash('') });
    await writeFile(join(workspace, 'bom.txt'), '\uFEFF第一行\r\n末行');
    expect(output(await execute('read_file', { path: 'bom.txt' }))['content']).toBe('\uFEFF第一行\r\n末行');
    expect(output(await execute('read_file', { path: 'bom.txt', startLine: 1, endLine: 1 }))['content']).toBe('\uFEFF第一行\r');
    expect(output(await execute('read_file', { path: 'bom.txt', startLine: 2, endLine: 99 }))).toMatchObject({ content: '末行', startLine: 2, endLine: 2, totalLines: 2 });
    await writeFile(join(workspace, 'over-limit.txt'), 'x'.repeat(2_000_001));
    const tooLarge = await execute('read_file', { path: 'over-limit.txt', startLine: 1, endLine: 1 });
    expect(tooLarge).toMatchObject({ status: 'error', error: { code: 'validation_error' } });
  });
  it('bounds output, redacts known credentials, and records result/time without file contents', async () => {
    process.env['ELVION_TEST_TOKEN'] = 'sensitive_token_for_test';
    try {
      runtime = new ToolRuntime({ maxOutputChars: 256 });
      await writeFile(join(workspace, 'a'), 'sensitive_token_for_test ' + 'x'.repeat(800));
      const result = await execute('read_file', { path: 'a' });
      expect(result.truncated).toBe(true); expect(JSON.stringify(result)).not.toContain('sensitive_token_for_test');
      const log = runtime.auditLog(); expect(log).toHaveLength(2); expect(log[1]?.durationMs).toBeGreaterThanOrEqual(0); expect(JSON.stringify(log)).not.toContain('xxx');
    } finally { delete process.env['ELVION_TEST_TOKEN']; }
  });
});

describe('permissions and canonical paths', () => {
  it('reports the resolved tool working directory separately from workspace before approval', async () => {
    await mkdir(join(workspace, 'src')); await mkdir(join(root, 'external'));
    for (const cwd of ['src', '../external']) {
      const pending = await execute('bash', { command: 'echo must-not-execute', cwd });
      expect(pending.status).toBe('approval_required');
      if (pending.status !== 'approval_required') throw new Error('Expected a pending approval');
      const resolved = await realpath(join(workspace, cwd));
      expect(pending.approval).toMatchObject({ workspace: await realpath(workspace), cwd: resolved, scope: [resolved], toolCall: { name: 'bash', arguments: { cwd } } });
    }
    expect(runtime.auditLog().filter(item => item.phase === 'finished').every(item => item.status === 'approval_required')).toBe(true);
  });
  it('requires approval for every ask-mode tool, including todo, and correlates a unique approval ID', async () => {
    const pending = await execute('todo', { operation: 'list' }, 'ask'); expect(pending.status).toBe('approval_required');
    const request = call('todo', { operation: 'add', text: 'approved' });
    const result = await runtime.execute(request, { workspace, permissionMode: 'ask', signal: new AbortController().signal, approve: async approval => ({ requestId: approval.id, decision: 'approved' }) });
    expect(result.status).toBe('success');
    const mismatch = await runtime.execute(call('todo', { operation: 'add', text: 'no' }), { workspace, permissionMode: 'ask', signal: new AbortController().signal, approve: async () => ({ requestId: 'wrong', decision: 'approved' }) });
    expect(mismatch.status).toBe('denied');
    expect(output(await execute('todo', { operation: 'list' }))['items']).toHaveLength(1);
  });
  it('handles denial and cancellation without executing or retrying', async () => {
    for (const decision of ['denied', 'cancelled'] as const) {
      const result = await runtime.execute(call('write_file', { path: 'no.txt', content: 'no' }), { workspace, permissionMode: 'ask', signal: new AbortController().signal, approve: async approval => ({ requestId: approval.id, decision }) });
      expect(result.status).toBe(decision);
    }
    await expect(stat(join(workspace, 'no.txt'))).rejects.toThrow();
    const controller = new AbortController();
    const pending = runtime.execute(call('todo', { operation: 'list' }), { workspace, permissionMode: 'ask', signal: controller.signal, approve: async () => new Promise(() => {}) });
    setTimeout(() => controller.abort(), 30); expect((await pending).status).toBe('cancelled');
  });
  it('detects traversal and junction escape and permits outside access only after approval or full access', async () => {
    await writeFile(join(root, 'secret.txt'), 'outside'); await mkdir(join(root, 'external')); await writeFile(join(root, 'external', 'data'), 'external');
    expect((await execute('read_file', { path: '../secret.txt' })).status).toBe('approval_required');
    await symlink(join(root, 'external'), join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await execute('read_file', { path: 'link/data' })).status).toBe('approval_required');
    expect((await execute('write_file', { path: 'link/new', content: 'blocked' })).status).toBe('approval_required');
    expect(output(await execute('read_file', { path: '../secret.txt' }, 'full-access'))['content']).toBe('outside');
    expect((await execute('write_file', { path: '.git/config', content: 'bad' }, 'full-access')).status).toBe('denied');
  });
});

describe('search and auxiliary todos', () => {
  it('searches nested Chinese text, filters results, skips dependencies and junctions', async () => {
    await mkdir(join(workspace, 'src')); await mkdir(join(workspace, 'node_modules'));
    await writeFile(join(workspace, 'src', '一.ts'), 'const 中文 = 1;\nneedle\n'); await writeFile(join(workspace, 'src', '二.txt'), 'needle'); await writeFile(join(workspace, 'node_modules', 'hidden.ts'), 'needle');
    expect(output(await execute('glob', { pattern: '**/*.ts' }))['files']).toEqual(['src/一.ts']);
    const found = output(await execute('grep', { pattern: '中文', filePattern: '**/*.ts' }))['matches']; expect(found).toHaveLength(1);
    expect(output(await execute('grep', { pattern: '^const', regex: true, filePattern: '**/*.ts' }))['matches']).toHaveLength(1);
    expect(output(await execute('glob', { pattern: '**/*', exclude: ['src/**'] }))['files']).toEqual([]);
    expect((await execute('glob', { pattern: '../*' })).status).toBe('error');
    expect((await execute('grep', { pattern: '[', regex: true })).status).toBe('error');
  });
  it('updates and removes auxiliary todo items with state checks', async () => {
    expect(output(await execute('todo', { operation: 'add', id: 'one', text: 'work' }))['items']).toHaveLength(1);
    expect((await execute('todo', { operation: 'add', id: 'one', text: 'duplicate' })).status).toBe('error');
    expect(output(await execute('todo', { operation: 'update', id: 'one', status: 'completed' }))['items']).toEqual([{ id: 'one', text: 'work', status: 'completed' }]);
    expect(output(await execute('todo', { operation: 'remove', id: 'one' }))['items']).toEqual([]);
    expect((await execute('todo', { operation: 'update', id: 'unknown' })).status).toBe('error');
  });
});

describe('unified patches', () => {
  it('applies edit/create/delete only after every target validates and preserves CRLF', async () => {
    await writeFile(join(workspace, 'a.txt'), 'first\r\nsecond\r\n'); await writeFile(join(workspace, 'delete.txt'), 'delete\n');
    const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n first\n-second\n+updated\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-delete\n';
    expect(output(await execute('apply_patch', { patch }))['changeRecords']).toHaveLength(3);
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('first\r\nupdated\r\n'); expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe('created\n'); await expect(stat(join(workspace, 'delete.txt'))).rejects.toThrow();
    expect((await execute('apply_patch', { patch })).status).toBe('error');
  });
  it('leaves earlier files untouched when later context is invalid', async () => {
    await writeFile(join(workspace, 'a'), 'one\n'); await writeFile(join(workspace, 'b'), 'two\n');
    const patch = '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-one\n+changed\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-wrong\n+bad\n';
    expect((await execute('apply_patch', { patch })).status).toBe('error'); expect(await readFile(join(workspace, 'a'), 'utf8')).toBe('one\n');
    expect((await execute('apply_patch', { patch: '--- a/../../bad\n+++ b/../../bad\n@@ -1 +1 @@\n-x\n+y\n' })).status).toBe('error');
  });
  it('validates hunk counts and newline markers', () => {
    expect(() => parsePatch('--- a/a\n+++ b/a\n@@ -1,2 +1 @@\n-x\n+y\n')).toThrow();
    const target = parsePatch('--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n')[0]!;
    expect(applyHunks('old', target)).toBe('new'); expect(() => applyHunks('old\n', target)).toThrow();
  });
  it('rolls back real edit/create/delete operations after a later write fails', async () => {
    workspace = await realpath(workspace);
    await writeFile(join(workspace, 'modified.txt'), 'before\r\n');
    await writeFile(join(workspace, 'deleted.txt'), 'deleted\n');
    const originalWrite = files.atomicWrite; let injected = 0; const writes: string[] = [];
    vi.spyOn(files, 'atomicWrite').mockImplementation(async (path, content, expected) => {
      writes.push(path);
      if (path === join(workspace, 'last.txt')) { injected++; throw new Error('Injected final write failure'); }
      return originalWrite(path, content, expected);
    });
    const patch = '--- a/modified.txt\n+++ b/modified.txt\n@@ -1 +1 @@\n-before\n+after\n--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n--- /dev/null\n+++ b/last.txt\n@@ -0,0 +1 @@\n+last\n';
    const result = await execute('apply_patch', { patch });
    expect(injected).toBe(1); expect(result).toMatchObject({ status: 'error', error: { code: 'tool_error' } });
    if (result.status === 'error') expect(result.error.details?.['requiresReview']).not.toBe(true);
    expect(await readFile(join(workspace, 'modified.txt'), 'utf8')).toBe('before\r\n');
    expect(await readFile(join(workspace, 'deleted.txt'), 'utf8')).toBe('deleted\n');
    await expect(stat(join(workspace, 'created.txt'))).rejects.toThrow(); await expect(stat(join(workspace, 'last.txt'))).rejects.toThrow();
    expect(writes).toEqual(['modified.txt', 'created.txt', 'last.txt', 'deleted.txt', 'modified.txt'].map(path => join(workspace, path)));
    expect((await readdir(workspace)).some(name => name.startsWith('.elvion-'))).toBe(false);
  });
  it('rolls back the first completed file if cancellation arrives before the next patch target', async () => {
    workspace = await realpath(workspace);
    await writeFile(join(workspace, 'first.txt'), 'before\n'); await writeFile(join(workspace, 'second.txt'), 'untouched\n');
    const controller = new AbortController(); const originalWrite = files.atomicWrite; let cancelledAfterWrite = 0; let rollbackWrites = 0;
    vi.spyOn(files, 'atomicWrite').mockImplementation(async (path, content, expected) => {
      const change = await originalWrite(path, content, expected);
      if (path === join(workspace, 'first.txt') && content === 'after\n') { cancelledAfterWrite++; controller.abort(); }
      else if (path === join(workspace, 'first.txt') && content === 'before\n') rollbackWrites++;
      return change;
    });
    const patch = '--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-before\n+after\n--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-untouched\n+must-not-write\n';
    const result = await runtime.execute(call('apply_patch', { patch }), { workspace, permissionMode: 'auto-edit', signal: controller.signal });
    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect(cancelledAfterWrite).toBe(1); expect(rollbackWrites).toBe(1);
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe('untouched\n');
    expect((await readdir(workspace)).some(name => name.startsWith('.elvion-'))).toBe(false);
  });
});

describe('structured Git and real Git Bash', { timeout: 60_000 }, () => {
  it('reports real diffs and stages/commits only owned clean-baseline paths', async () => {
    await initRepo(); await writeFile(join(workspace, 'baseline'), 'start\n'); await git('add', '--', 'baseline'); await git('commit', '-m', 'base');
    await writeFile(join(workspace, 'user-change'), 'user data');
    expect((await execute('git', { operation: 'add', paths: ['baseline'] })).status).toBe('approval_required');
    expect((await execute('git', { operation: 'add', paths: ['user-change'] }, 'full-access')).status).toBe('denied');
    expect((await execute('write_file', { path: 'feature.ts', content: 'export const value = 1;\n' })).status).toBe('success');
    expect(output(await execute('git', { operation: 'add', paths: ['feature.ts'] }, 'full-access'))['exitCode']).toBe(0);
    const diff = output(await execute('diff', { staged: true })); expect(diff['stdout']).toContain('+export const value');
    const committed = output(await execute('git', { operation: 'commit', paths: ['feature.ts'], message: '测试提交' }, 'full-access')); expect(committed['exitCode']).toBe(0);
    expect(await git('status', '--porcelain')).toContain('user-change'); expect(await git('log', '-1', '--format=%s')).toContain('测试提交');
    expect((await execute('git', { operation: 'reset', paths: ['baseline'] }, 'full-access')).status).toBe('error');
  });
  it('protects pre-existing edits and unrelated staged changes', async () => {
    await initRepo(); await writeFile(join(workspace, 'existing'), 'base'); await git('add', '--', 'existing'); await git('commit', '-m', 'base');
    await writeFile(join(workspace, 'existing'), 'user'); await execute('edit_file', { path: 'existing', oldText: 'user', newText: 'user+agent' });
    expect((await execute('git', { operation: 'add', paths: ['existing'] }, 'full-access')).status).toBe('denied');
    await execute('write_file', { path: 'owned', content: 'own' }); await execute('git', { operation: 'add', paths: ['owned'] }, 'full-access');
    await git('add', '--', 'existing');
    expect((await execute('git', { operation: 'commit', paths: ['owned'], message: 'no' }, 'full-access')).status).toBe('error');
    expect(await git('log', '--format=%s')).toBe('base\n');
  });
  it('treats bracket filenames as literal paths without staging or committing matching user files', async () => {
    await initRepo(); await writeFile(join(workspace, 'filea.txt'), 'baseline\n');
    await git('add', '--', 'filea.txt'); await git('commit', '-m', 'base');
    await execute('write_file', { path: 'file[ab].txt', content: 'owned\n' });
    // Change after ownership capture so this also detects add/commit pathspec expansion.
    await writeFile(join(workspace, 'filea.txt'), 'user change\n');
    expect(output(await execute('git', { operation: 'add', paths: ['file[ab].txt'] }, 'full-access'))['exitCode']).toBe(0);
    expect(await git('diff', '--cached', '--name-only')).toBe('file[ab].txt\n');
    expect(output(await execute('git', { operation: 'commit', paths: ['file[ab].txt'], message: 'literal file only' }, 'full-access'))['exitCode']).toBe(0);
    expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('file[ab].txt\n');
    expect(await git('show', 'HEAD:filea.txt')).toBe('baseline\n');
    expect(await readFile(join(workspace, 'filea.txt'), 'utf8')).toBe('user change\n');
    expect(await git('status', '--porcelain')).toContain(' M filea.txt');
  });
  it('compares subdirectory commit paths from the repository root and rejects staged changes outside that directory', async () => {
    await initRepo(); await writeFile(join(workspace, 'outside.txt'), 'baseline\n'); await mkdir(join(workspace, 'src'));
    await git('add', '--', 'outside.txt'); await git('commit', '-m', 'base');
    await execute('write_file', { path: 'src/owned.txt', content: 'owned\n' });
    expect(output(await execute('git', { operation: 'add', cwd: 'src', paths: ['owned.txt'] }, 'full-access'))['exitCode']).toBe(0);
    expect(output(await execute('git', { operation: 'commit', cwd: 'src', paths: ['owned.txt'], message: 'subdirectory only' }, 'full-access'))['exitCode']).toBe(0);
    expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe('src/owned.txt\n');
    await execute('edit_file', { path: 'src/owned.txt', oldText: 'owned', newText: 'updated' });
    await execute('git', { operation: 'add', cwd: 'src', paths: ['owned.txt'] }, 'full-access');
    await writeFile(join(workspace, 'outside.txt'), 'user staged change\n'); await git('add', '--', 'outside.txt');
    await git('config', 'diff.relative', 'true');
    const blocked = await execute('git', { operation: 'commit', cwd: 'src', paths: ['owned.txt'], message: 'must not commit' }, 'full-access');
    expect(blocked).toMatchObject({ status: 'error', error: { code: 'conflict' } });
    expect(await git('log', '-1', '--format=%s')).toBe('subdirectory only\n');
    expect(await git('diff', '--cached', '--name-only')).toBe('outside.txt\nsrc/owned.txt\n');
  });
  it('finds Git Bash, requires authorization, captures exit codes and bounds output', async () => {
    expect(await findGitBash()).toContain('bash'); await expect(findGitBash(join(root, 'missing.exe'))).rejects.toThrow();
    expect((await execute('bash', { command: 'printf allowed' })).status).toBe('approval_required');
    const result = output(await execute('bash', { command: 'printf 中文; printf err >&2; exit 7' }, 'full-access'));
    expect(result['stdout']).toBe('中文'); expect(result['stderr']).toBe('err'); expect(result['exitCode']).toBe(7);
    runtime = new ToolRuntime({ maxOutputChars: 256 });
    const bounded = await execute('bash', { command: 'printf %01000d 0' }, 'full-access'); expect(output(bounded)['stdout']).toHaveLength(256);
  });
  it('terminates actual child trees on timeout and cancellation before returning', async () => {
    const command = '(sleep 4; printf leaked > marker) & printf started > started; wait';
    const timed = await execute('bash', { command, timeoutMs: 1_500 }, 'full-access'); expect(timed.status).toBe('error'); if (timed.status === 'error') expect(timed.error.code).toBe('timeout');
    expect(await readFile(join(workspace, 'started'), 'utf8')).toBe('started');
    await rm(join(workspace, 'started'));
    const controller = new AbortController(); const pending = runtime.execute(call('bash', { command }), { workspace, permissionMode: 'full-access', signal: controller.signal });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try { await stat(join(workspace, 'started')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    expect(await readFile(join(workspace, 'started'), 'utf8')).toBe('started');
    controller.abort(); expect((await pending).status).toBe('cancelled');
    await new Promise(resolve => setTimeout(resolve, 4_200)); await expect(stat(join(workspace, 'marker'))).rejects.toThrow();
  });
});
