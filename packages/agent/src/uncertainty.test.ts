import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker, type JsonValue, type ModelEvent, type ModelRuntime, type ToolCall } from '@elvion/kernel';
import { ToolRuntime } from '@elvion/tool';
import * as files from '../../tool/src/files.js';
import { runAgent, type AgentEvent } from './index.js';

let workspace: string;
beforeEach(async () => { workspace = await realpath(await mkdtemp(join(tmpdir(), 'elvion-uncertainty-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const signal = (): AbortSignal => new AbortController().signal;
function model(calls: ToolCall[]): { runtime: ModelRuntime; requests: () => number } {
  let count = 0;
  return { requests: () => count, runtime: { async *stream(): AsyncIterable<ModelEvent> {
    count++;
    if (count === 1) { for (const call of calls) yield { type: 'tool_call', call }; yield { type: 'done', finishReason: 'tool_calls' }; }
    else { yield { type: 'text_delta', text: 'Completed after correcting the input.' }; yield { type: 'done', finishReason: 'stop' }; }
  } } };
}
function agent(runtime: ModelRuntime, tools = new ToolRuntime()): AsyncIterable<AgentEvent> {
  return runAgent({ runtime, tools, model: 'fixture', workspace, permissionMode: 'auto-edit', signal: signal(), budget: new BudgetTracker(), goal: 'Apply changes and verify', messages: [] });
}
function patchCall(): ToolCall {
  return { id: 'patch', name: 'apply_patch', arguments: { patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before-a\n+after-a\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-before-b\n+after-b\n' } };
}
function injectRollbackConflict(): () => number {
  const write = files.atomicWrite;
  let failuresInjected = 0;
  vi.spyOn(files, 'atomicWrite').mockImplementation(async (path, content, expected) => {
    if (path === join(workspace, 'b.txt')) {
      failuresInjected++;
      await writeFile(join(workspace, 'a.txt'), 'concurrent-user-change\n');
      throw new Error('Injected second-file write failure after a concurrent change');
    }
    return write(path, content, expected);
  });
  return () => failuresInjected;
}
describe('uncertain tool side effects', () => {
  it('marks a real partial patch with rollback failure for review and stops the agent before any more tools or model turns', async () => {
    await writeFile(join(workspace, 'a.txt'), 'before-a\n'); await writeFile(join(workspace, 'b.txt'), 'before-b\n');
    const failuresInjected = injectRollbackConflict();
    const source = model([patchCall(), { id: 'must-not-run', name: 'write_file', arguments: { path: 'later.txt', content: 'unsafe' } }]);
    const observed: AgentEvent[] = [];
    await expect((async () => { for await (const event of agent(source.runtime)) observed.push(event); })()).rejects.toMatchObject({
      code: 'conflict', retryable: false, details: { requiresReview: true, toolCallId: 'patch', toolName: 'apply_patch', rollbackFailures: [join(workspace, 'a.txt')] },
    });
    expect(failuresInjected()).toBe(1);
    expect(source.requests()).toBe(1);
    const finished = observed.find(event => event.type === 'tool.finished')?.payload as Record<string, JsonValue>;
    expect(finished).toMatchObject({ status: 'error', error: { code: 'conflict', details: { requiresReview: true, rollbackFailures: [join(workspace, 'a.txt')] } } });
    expect(observed.filter(event => event.type === 'tool.started')).toHaveLength(1);
    expect(observed.some(event => event.type === 'agent.delivery')).toBe(false);
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('concurrent-user-change\n');
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('before-b\n');
    await expect(readFile(join(workspace, 'later.txt'))).rejects.toThrow();
  });
  it('stops on explicit review flags and legacy rollback failures without matching error message text', async () => {
    for (const details of [{ requiresReview: true }, { rollbackFailures: ['file.txt'] }]) {
      const tools = new ToolRuntime();
      vi.spyOn(tools, 'execute').mockResolvedValue({ toolCallId: 'x', durationMs: 1, truncated: false, status: 'error', error: { code: 'tool_error', message: 'Opaque failure', retryable: false, details } });
      const source = model([{ id: 'x', name: 'todo', arguments: { operation: 'list' } }]);
      await expect((async () => { for await (const event of agent(source.runtime, tools)) expect(event.type).not.toBe('agent.delivery'); })()).rejects.toMatchObject({ code: 'conflict', details: { requiresReview: true } });
      expect(source.requests()).toBe(1);
    }
  });
  it('continues ordinary safe tool errors and allows subsequent tools and a model correction', async () => {
    await writeFile(join(workspace, 'a.txt'), 'original\n');
    const source = model([
      { id: 'bad-edit', name: 'edit_file', arguments: { path: 'a.txt', oldText: 'missing', newText: 'replacement' } },
      { id: 'safe-write', name: 'write_file', arguments: { path: 'later.txt', content: 'safe' } },
    ]);
    const observed: AgentEvent[] = []; for await (const event of agent(source.runtime)) observed.push(event);
    expect(source.requests()).toBe(2); expect(observed.some(event => event.type === 'agent.delivery')).toBe(true);
    expect(observed.filter(event => event.type === 'tool.finished')).toHaveLength(2);
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('original\n');
    expect(await readFile(join(workspace, 'later.txt'), 'utf8')).toBe('safe');
  });
});
