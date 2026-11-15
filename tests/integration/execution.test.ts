import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../../packages/agent/src/index.js';
import { buildContext } from '../../packages/context/src/index.js';
import { executeTask } from '../../packages/execution/src/index.js';
import { recoveryDecision } from '../../packages/recovery/src/index.js';
import { SessionRepository } from '../../packages/session/src/index.js';
import type { SessionSnapshot } from '../../packages/session/src/index.js';
import { TaskGraph } from '../../packages/task/src/index.js';
import { ToolRuntime } from '../../packages/tool/src/index.js';
import { BudgetTracker, ElvionError, EventSequencer } from '../../packages/kernel/src/index.js';
import type { ApprovalHandler, JsonObject, ModelEvent, ModelMessage, ModelRequest, ModelRuntime } from '../../packages/kernel/src/index.js';

/** Scripted model events validate local engine behavior, never real provider acceptance. */
class ScriptedModel implements ModelRuntime {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelEvent> {
    options.signal.throwIfAborted(); this.requests.push(structuredClone(request));
    const turn = this.turns.shift();
    if (!turn) throw new ElvionError('model_error', 'Fixture ran out of explicit model turns');
    yield* turn;
  }
}
function tool(name: string, args: JsonObject, id: string = randomUUID()): ModelEvent { return { type: 'tool_call', call: { id, name, arguments: args } }; }
function calls(...events: ModelEvent[]): ModelEvent[] { return [...events, { type: 'done', finishReason: 'tool_calls' }]; }
function delivery(text = '已修改，等待独立验证。'): ModelEvent[] { return [{ type: 'text_delta', text }, { type: 'done', finishReason: 'stop' }]; }
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const event of events) result.push(event); return result; }
const approve: ApprovalHandler = async request => ({ requestId: request.id, decision: 'approved' });

describe('task state and context contracts', () => {
  const task = (id: string, dependsOn: string[] = []) => ({ id, title: id, dependsOn, acceptance: ['tests pass'] });
  it('rejects duplicate IDs, missing dependencies and cycles', () => {
    expect(() => new TaskGraph([task('a'), task('a')])).toThrow('Duplicate');
    expect(() => new TaskGraph([task('a', ['missing'])])).toThrow('Missing');
    expect(() => new TaskGraph([task('a', ['b']), task('b', ['a'])])).toThrow('cycle');
  });
  it('schedules dependencies serially and requires independent verified evidence', () => {
    const graph = new TaskGraph([task('a'), task('b', ['a'])]);
    expect(graph.next()?.id).toBe('a');
    expect(() => graph.transition('b', 'running')).toThrow();
    graph.transition('a', 'running');
    expect(graph.next()).toBeUndefined();
    expect(() => graph.transition('a', 'completed')).toThrow('verification');
    graph.transition('a', 'completed', { verified: true });
    expect(graph.next()?.id).toBe('b');
    graph.transition('b', 'running'); graph.transition('b', 'completed', { verified: true });
    expect(graph.next()).toBeUndefined();
    const copy = graph.snapshot(); copy[0]!.status = 'failed';
    expect(graph.snapshot()[0]?.status).toBe('completed');
  });
  it('keeps complete multi-tool exchanges, goal, acceptance and decisions inside budget', () => {
    const callA = { id: 'call-a', name: 'read_file', arguments: { path: 'a.ts' } };
    const callB = { id: 'call-b', name: 'read_file', arguments: { path: 'b.ts' } };
    const messages: ModelMessage[] = [{ role: 'system', content: 'System policy' }, { role: 'user', content: 'old '.repeat(300) }, { role: 'assistant', content: '', toolCalls: [callA, callB] }, { role: 'tool', toolCallId: callA.id, content: 'a' }, { role: 'tool', toolCallId: callB.id, content: 'b' }, { role: 'user', content: 'next' }];
    const selected = buildContext(messages, { goal: '目标', acceptance: ['验证通过'], decisions: ['保留接口'], remaining: ['补测试'], maxCharacters: 1024 });
    expect(selected[0]).toEqual(messages[0]);
    expect(JSON.stringify(selected[1])).toContain('目标');
    expect(JSON.stringify(selected[1])).toContain('保留接口');
    expect(selected.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(selected.some(message => message.content.includes('old old'))).toBe(false);
    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(1024);
  });
  it('does not retry denial, cancellation or uncertain side effects', () => {
    expect(recoveryDecision(new ElvionError('cancelled', 'cancel'), { retries: 0, repairs: 0 })).toBe('stop');
    expect(recoveryDecision(new ElvionError('permission_denied', 'deny'), { retries: 0, repairs: 0 })).toBe('stop');
    expect(recoveryDecision(new ElvionError('model_error', 'retry', { retryable: true }), { retries: 2, repairs: 0 })).toBe('stop');
    expect(recoveryDecision(new Error('unknown'), { retries: 0, repairs: 0, sideEffectUncertain: true })).toBe('review');
  });
  it('rejects orphan, duplicate and unfinished tool context instead of sending invalid history', () => {
    const call = { id: 'c', name: 'read_file', arguments: { path: 'file' } };
    expect(() => buildContext([{ role: 'tool', toolCallId: 'c', content: 'orphan' }], { goal: 'test' })).toThrow();
    expect(() => buildContext([{ role: 'assistant', content: '', toolCalls: [call] }], { goal: 'test' })).toThrow();
    expect(() => buildContext([{ role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', toolCallId: 'c', content: 'result' }, { role: 'tool', toolCallId: 'c', content: 'duplicate' }], { goal: 'test' })).toThrow();
  });
});

describe('real local execution with scripted model events', () => {
  let directory: string; let repository: SessionRepository;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'elvion-execution-')); repository = await SessionRepository.open(join(directory, 'sessions.sqlite')); });
  afterEach(async () => { vi.unstubAllEnvs(); if (repository) await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const options = (runtime: ModelRuntime) => ({ task: '实现跨文件功能并验证', workspace: directory, providerId: 'scripted-local-fixture', model: 'fixture', runtime, repository, plan: [{ id: 'coding', title: '实现跨文件功能并验证', acceptance: ['Independent project verification passes'] }], lockDirectory: join(directory, 'locks') });
  it('runs real file tools, preserves tool-result association and streams final text', async () => {
    await writeFile(join(directory, 'source.txt'), '中文源文件\r\n');
    const runtime = new ScriptedModel([calls(tool('read_file', { path: 'source.txt' }, 'read-one'), tool('write_file', { path: 'new.txt', content: 'created' }, 'write-two')), delivery()]);
    const messages: ModelMessage[] = [{ role: 'user', content: '读取并创建' }];
    const events = await collect(runAgent({ runtime, model: 'fixture', tools: new ToolRuntime(), workspace: directory, permissionMode: 'auto-edit', signal: new AbortController().signal, budget: new BudgetTracker(), goal: '读取并创建', messages }));
    expect(await readFile(join(directory, 'new.txt'), 'utf8')).toBe('created');
    expect(messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['read-one', 'write-two']);
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]?.messages.filter(message => message.role === 'tool')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('agent.delivery');
    expect(events.filter(event => event.type === 'tool.finished')).toHaveLength(2);
  });
  it('repairs a real failed check, then persists verified completion and exact diff contents', async () => {
    const manifest = { private: true, type: 'module', scripts: { test: 'node verify.mjs' } };
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'verify.mjs'), `import {readFileSync} from 'node:fs';\nconst a=readFileSync('a.txt','utf8'); const b=readFileSync('b.txt','utf8');\nif(a!=='first' || b!=='fixed') { console.error('b.txt must be fixed'); process.exitCode=1; }\n`);
    const runtime = new ScriptedModel([calls(tool('write_file', { path: 'a.txt', content: 'first' }), tool('write_file', { path: 'b.txt', content: 'broken' })), delivery(), calls(tool('edit_file', { path: 'b.txt', oldText: 'broken', newText: 'fixed' })), delivery('已根据测试证据修复 b.txt。')]);
    const events = await collect(executeTask({ ...options(runtime), permissions: 'full-access', approve }));
    expect(events.filter(event => event.type === 'execution.repair')).toHaveLength(1);
    const reports = events.filter(event => event.type === 'verification.finished').map(event => event.payload);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ passed: false, checks: [{ name: 'test', exitCode: 1, status: 'failed' }] });
    expect(reports[1]).toMatchObject({ passed: true, checks: [{ name: 'test', exitCode: 0, status: 'passed' }] });
    expect(events.at(-1)?.type).toBe('execution.completed');
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('first');
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('fixed');
    const state = await repository.get(events[0]!.sessionId);
    expect(state?.state).toBe('completed'); expect(state?.permissions).toBe('full-access');
    const persisted = await repository.events(state!.id);
    expect(persisted.map(event => event.sequence)).toEqual(persisted.map((_event, index) => index + 1));
    expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
    for (const event of events) expect(persisted[event.sequence - 1]).toEqual(event);
    expect(persisted.filter(event => event.type === 'tool.started' && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) && event.payload['source'] === 'verification')).toHaveLength(4);
    expect(await readdir(join(directory, 'locks'))).toEqual([]);
  }, 120_000);
  it('returns approval_required in noninteractive ask mode without touching files', async () => {
    const runtime = new ScriptedModel([calls(tool('write_file', { path: 'blocked.txt', content: 'must not exist' }))]);
    const events = await collect(executeTask({ ...options(runtime), permissions: 'ask' }));
    expect(events.at(-1)?.type).toBe('execution.approval_required');
    expect(events.filter(event => event.type === 'tool.finished')[0]?.payload).toMatchObject({ status: 'approval_required' });
    await expect(readFile(join(directory, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.requests).toHaveLength(0);
  });
  it('does not retry denied authorization or run denied side effects', async () => {
    const runtime = new ScriptedModel([calls(tool('write_file', { path: 'denied.txt', content: 'must not exist' }))]);
    const deny: ApprovalHandler = async request => ({ requestId: request.id, decision: 'denied' });
    const events = await collect(executeTask({ ...options(runtime), permissions: 'ask', approve: deny }));
    expect(events.at(-1)?.type).toBe('execution.failed');
    expect(events.at(-1)?.payload).toMatchObject({ error: { code: 'permission_denied' } });
    expect(events.some(event => event.type === 'execution.retry' || event.type === 'execution.repair')).toBe(false);
    await expect(readFile(join(directory, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists cancellation and releases workspace ownership', async () => {
    const signal = new AbortController(); signal.abort(new ElvionError('cancelled', 'User cancelled'));
    const runtime = new ScriptedModel([delivery()]);
    const events = await collect(executeTask({ ...options(runtime), signal: signal.signal }));
    expect(events.at(-1)?.type).toBe('execution.cancelled');
    expect(runtime.requests).toHaveLength(0);
    expect((await repository.get(events[0]!.sessionId))?.state).toBe('cancelled');
    expect(await readdir(join(directory, 'locks'))).toEqual([]);
  });
  it('cancels an in-flight approval and never performs the pending write', async () => {
    const signal = new AbortController();
    const waitForUser: ApprovalHandler = async (_request, pending) => {
      signal.abort(new ElvionError('cancelled', 'Cancel while awaiting approval'));
      return await new Promise((_resolve, reject) => {
        if (pending.signal.aborted) reject(pending.signal.reason);
        else pending.signal.addEventListener('abort', () => reject(pending.signal.reason), { once: true });
      });
    };
    const runtime = new ScriptedModel([calls(tool('write_file', { path: 'not-created.txt', content: 'cancelled' }))]);
    const events = await collect(executeTask({ ...options(runtime), permissions: 'ask', signal: signal.signal, approve: waitForUser }));
    expect(events.at(-1)?.type).toBe('execution.cancelled');
    expect(events.some(event => event.type === 'execution.retry' || event.type === 'execution.repair')).toBe(false);
    await expect(readFile(join(directory, 'not-created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resumes uncertain side effects as needs_review without replay or model calls', async () => {
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'scripted-local-fixture', permissions: 'ask', state: 'running', task: 'previous action', messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
    await repository.save(state);
    await writeFile(join(directory, 'previous.txt'), 'side effect already happened');
    const runtime = new ScriptedModel([delivery()]);
    const events = await collect(executeTask({ ...options(runtime), session: state }));
    expect(events.map(event => event.type)).toEqual(['execution.needs_review']);
    expect(runtime.requests).toHaveLength(0);
    expect((await repository.get(state.id))?.permissions).toBe('ask');
    expect(await readFile(join(directory, 'previous.txt'), 'utf8')).toBe('side effect already happened');
  });
  it.each(['saved', 'requested'])('resumes the same directory through a real %s workspace alias while retaining its saved identity', async aliased => {
    const target = join(directory, 'actual-workspace');
    const alias = join(directory, 'workspace-alias');
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = await realpath(target);
    expect(await realpath(alias)).toBe(canonical);
    const savedWorkspace = aliased === 'saved' ? alias : canonical;
    const requestedWorkspace = aliased === 'requested' ? alias : canonical;
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: savedWorkspace, providerId: 'scripted-local-fixture', permissions: 'ask', state: 'running', task: 'previous action', messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
    await repository.save(state);
    await writeFile(join(canonical, 'previous.txt'), 'existing side effect');
    const runtime = new ScriptedModel([]);
    const events = await collect(executeTask({ ...options(runtime), workspace: requestedWorkspace, session: state }));
    expect(events.map(event => event.type)).toEqual(['execution.needs_review']);
    expect(runtime.requests).toHaveLength(0);
    expect(await repository.get(state.id)).toMatchObject({ workspace: savedWorkspace, permissions: 'ask', state: 'needs_review', lastSequence: 1 });
    expect(await readFile(join(canonical, 'previous.txt'), 'utf8')).toBe('existing side effect');
  });
  it.runIf(process.platform === 'win32')('resumes a saved workspace whose path uses different casing', async () => {
    const canonical = await realpath(directory);
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: canonical.toUpperCase(), providerId: 'scripted-local-fixture', permissions: 'ask', state: 'running', task: 'previous action', messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
    await repository.save(state);
    const runtime = new ScriptedModel([]);
    const events = await collect(executeTask({ ...options(runtime), workspace: canonical, session: state }));
    expect(events.map(event => event.type)).toEqual(['execution.needs_review']);
    expect(runtime.requests).toHaveLength(0);
    expect(await repository.get(state.id)).toMatchObject({ workspace: state.workspace, state: 'needs_review' });
  });
  it.each(['workspace', 'provider'])('rejects a resumed session with a different %s before acquiring a lock', async changed => {
    const otherWorkspace = join(directory, 'different-workspace');
    await mkdir(otherWorkspace);
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'scripted-local-fixture', permissions: 'ask', state: 'running', task: 'previous action', messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
    await repository.save(state);
    const runtime = new ScriptedModel([]);
    await expect(collect(executeTask({ ...options(runtime), workspace: changed === 'workspace' ? otherWorkspace : directory, providerId: changed === 'provider' ? 'different-provider' : state.providerId, session: state }))).rejects.toMatchObject({ code: 'configuration_error' });
    expect(runtime.requests).toHaveLength(0);
    expect(await repository.get(state.id)).toMatchObject({ workspace: state.workspace, providerId: state.providerId, state: 'running', lastSequence: 0 });
    expect(await repository.events(state.id)).toEqual([]);
    await expect(readdir(join(directory, 'locks'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a second execution while the same workspace is owned', async () => {
    const first = executeTask(options(new ScriptedModel([delivery()]))) [Symbol.asyncIterator]();
    try {
      expect((await first.next()).value?.type).toBe('execution.started');
      await expect(collect(executeTask(options(new ScriptedModel([delivery()]))))).rejects.toMatchObject({ code: 'conflict' });
    } finally { await first.return?.(); }
    expect(await readdir(join(directory, 'locks'))).toEqual([]);
  });
  it('restores a completed ask-mode session without silently starting another task', async () => {
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'scripted-local-fixture', permissions: 'ask', state: 'completed', task: 'previous task', messages: [{ role: 'user', content: '旧任务' }, { role: 'assistant', content: '已完成' }], lastSequence: 0, createdAt: now, updatedAt: now };
    const completed = new EventSequencer({ sessionId: state.id }).next('execution.completed', { report: { passed: true, checks: [{ name: 'test', command: ['node', 'check.mjs'], exitCode: 0, status: 'passed', evidence: 'Independent check completed' }] } });
    state.lastSequence = completed.sequence; await repository.save(state, [completed]);
    const runtime = new ScriptedModel([calls(tool('write_file', { path: 'restore-blocked.txt', content: 'blocked' }))]);
    const events = await collect(executeTask({ ...options(runtime), session: state }));
    expect(events[0]?.payload).toMatchObject({ permissions: 'ask' });
    expect(events.map(event => event.type)).toEqual(['session.restored', 'execution.completed']);
    expect(runtime.requests).toHaveLength(0);
    expect((await repository.get(state.id))?.permissions).toBe('ask');
    await expect(readFile(join(directory, 'restore-blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never treats a model delivery as verified when no objective checks exist', async () => {
    const events = await collect(executeTask(options(new ScriptedModel([delivery('所有任务已完成')]))));
    expect(events.at(-1)?.type).toBe('execution.failed');
    expect(events.some(event => event.type === 'execution.completed' || event.type === 'execution.repair')).toBe(false);
    expect(events.find(event => event.type === 'verification.finished')?.payload).toMatchObject({ passed: false, checks: [{ status: 'not_run' }] });
  });
  it.each(['delete', 'replace'])('requires review when a failed test script is weakened by %s', async change => {
    await writeFile(join(directory, 'failure.mjs'), 'process.exitCode = 1;');
    await writeFile(join(directory, 'success.mjs'), 'process.exitCode = 0;');
    const manifest = { private: true, scripts: { test: 'node failure.mjs', build: 'node success.mjs' } };
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    const altered = change === 'delete'
      ? { private: true, scripts: { build: manifest.scripts.build } }
      : { private: true, scripts: { ...manifest.scripts, test: 'node success.mjs' } };
    const runtime = new ScriptedModel([
      delivery('Ready for objective verification'),
      calls(tool('write_file', { path: 'package.json', content: JSON.stringify(altered), overwrite: true })),
      delivery('The checks should now pass'),
    ]);
    const events = await collect(executeTask({ ...options(runtime), permissions: 'full-access' }));
    expect(events.filter(event => event.type === 'execution.repair')).toHaveLength(1);
    expect(events.find(event => event.type === 'verification.finished')?.payload).toMatchObject({ passed: false, checks: expect.arrayContaining([{ name: 'test', command: ['npm', 'run', 'test'], exitCode: 1, status: 'failed', evidence: expect.any(String), failureReason: expect.any(String) }, { name: 'build', command: ['npm', 'run', 'build'], exitCode: 0, status: 'passed', evidence: expect.any(String) }]) });
    expect(events.at(-1)?.type).toBe('execution.needs_review');
    expect(events.at(-1)?.payload).toMatchObject({ error: { code: 'verification_failed', details: { requiresReview: true, changedScripts: ['test'] } } });
    expect(events.some(event => event.type === 'execution.completed')).toBe(false);
    const state = await repository.get(events[0]!.sessionId);
    expect(state?.state).toBe('needs_review');
    expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))).toEqual(altered);
    const resumed = new ScriptedModel([delivery('Must not run')]);
    const restored = await collect(executeTask({ ...options(resumed), session: state! }));
    expect(restored.map(event => event.type)).toEqual(['execution.needs_review']);
    expect(resumed.requests).toHaveLength(0);
  }, 120_000);
  it('stops after the configured model turn budget without fake completion', async () => {
    const runtime = new ScriptedModel([calls(tool('todo', { operation: 'list' }))]);
    const events = await collect(executeTask({ ...options(runtime), budget: { maxTurns: 1 } }));
    expect(events.at(-1)?.type).toBe('execution.failed');
    expect(events.at(-1)?.payload).toMatchObject({ error: { code: 'budget_exceeded' } });
    expect(events.some(event => event.type === 'execution.completed')).toBe(false);
  });
  it('times out an in-flight model stream and propagates local abort', async () => {
    await repository.list();
    let streamEntered = false; let streamAborted = false;
    const runtime: ModelRuntime = {
      async *stream(_request, pending) {
        streamEntered = true;
        await new Promise<void>((_resolve, reject) => {
          const cancel = () => { streamAborted = true; reject(pending.signal.reason); };
          if (pending.signal.aborted) cancel(); else pending.signal.addEventListener('abort', cancel, { once: true });
        });
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const events = await collect(executeTask({ ...options(runtime), budget: { maxDurationMs: 2000 } }));
    expect(streamEntered).toBe(true);
    expect(streamAborted).toBe(true);
    expect(events.at(-1)?.type).toBe('execution.timed_out');
    expect(events.some(event => event.type === 'execution.retry' || event.type === 'execution.completed')).toBe(false);
    expect(await readdir(join(directory, 'locks'))).toEqual([]);
  });
  it('requires approval for auto-edit verification shells and returns instead of hanging', async () => {
    await writeFile(join(directory, 'success.mjs'), 'process.exitCode = 0;');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node success.mjs' } }));
    const events = await collect(executeTask(options(new ScriptedModel([delivery()]))));
    expect(events.at(-1)?.type).toBe('execution.approval_required');
    const persisted = await repository.events(events[0]!.sessionId);
    expect(persisted.find(event => event.type === 'tool.finished' && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) && event.payload['status'] === 'approval_required')?.payload).toMatchObject({ source: 'verification', status: 'approval_required' });
    expect(events.at(-1)?.payload).toMatchObject({ budget: { toolCalls: 3 } });
  });
  it('counts verification tools in the same hard tool-call budget', async () => {
    await writeFile(join(directory, 'success.mjs'), 'process.exitCode = 0;');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node success.mjs' } }));
    const events = await collect(executeTask({ ...options(new ScriptedModel([delivery()])), permissions: 'full-access', budget: { maxToolCalls: 1 } }));
    expect(events.at(-1)?.type).toBe('execution.failed');
    expect(events.at(-1)?.payload).toMatchObject({ error: { code: 'budget_exceeded' }, budget: { toolCalls: 1 } });
    const persisted = await repository.events(events[0]!.sessionId);
    expect(persisted.filter(event => event.type === 'tool.started')).toHaveLength(1);
  });
  it('does not replay or replan a completed task when restoring a stable session', async () => {
    await writeFile(join(directory, 'once.txt'), 'old task side effect');
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'scripted-local-fixture', permissions: 'auto-edit', state: 'completed', task: 'old completed task', messages: [{ role: 'user', content: 'old task' }, { role: 'assistant', content: '', toolCalls: [{ id: 'old-write', name: 'write_file', arguments: { path: 'once.txt', content: 'old task side effect' } }] }, { role: 'tool', toolCallId: 'old-write', content: JSON.stringify({ status: 'success' }) }, { role: 'assistant', content: 'done' }], lastSequence: 0, createdAt: now, updatedAt: now };
    const completed = new EventSequencer({ sessionId: state.id }).next('execution.completed', { report: { passed: true, checks: [{ name: 'test', command: ['node', 'check.mjs'], exitCode: 0, status: 'passed', evidence: 'Independent check completed' }] } });
    state.lastSequence = completed.sequence; await repository.save(state, [completed]);
    const runtime = new ScriptedModel([delivery('新任务等待验证')]);
    const events = await collect(executeTask({ ...options(runtime), task: 'new task', session: state }));
    expect(runtime.requests).toHaveLength(0);
    expect(events.map(event => event.type)).toEqual(['session.restored', 'execution.completed']);
    expect((await repository.get(state.id))?.task).toBe('old completed task');
    expect(events.filter(event => event.type === 'tool.started' && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) && event.payload['source'] === undefined)).toHaveLength(0);
    expect(await readFile(join(directory, 'once.txt'), 'utf8')).toBe('old task side effect');
  });
  it('reviews unmatched persisted tool intent even when the old terminal state is failed', async () => {
    const now = new Date().toISOString();
    const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'scripted-local-fixture', permissions: 'auto-edit', state: 'failed', task: 'interrupted tool', messages: [], lastSequence: 1, createdAt: now, updatedAt: now };
    const intent = new EventSequencer({ sessionId: state.id }).next('tool.started', { id: 'unknown-write', name: 'write_file', arguments: { path: 'unknown.txt', content: 'value' } });
    await repository.save(state, [intent]);
    const runtime = new ScriptedModel([delivery()]);
    const events = await collect(executeTask({ ...options(runtime), session: state }));
    expect(events.map(event => event.type)).toEqual(['execution.needs_review']);
    expect(runtime.requests).toHaveLength(0);
  });
  it('rejects invalid budgets before acquiring a workspace lock', async () => {
    await expect(collect(executeTask({ ...options(new ScriptedModel([delivery()])), budget: { maxTurns: 0 } }))).rejects.toBeDefined();
    const files = await readdir(join(directory, 'locks')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    expect(files).toEqual([]);
    const again = executeTask(options(new ScriptedModel([delivery()]))) [Symbol.asyncIterator]();
    try { expect((await again.next()).value?.type).toBe('execution.started'); } finally { await again.return?.(); }
  });
  it('redacts split model secrets and tool parameters from events, model context and saved snapshots', async () => {
    const secret = 'private-test-key-471942'; vi.stubEnv('ELVION_INTEGRATION_API_KEY', secret);
    const runtime = new ScriptedModel([[{ type: 'text_delta', text: 'prefix '.repeat(60) + secret.slice(0, 9) }, { type: 'text_delta', text: secret.slice(9) }, tool('write_file', { path: 'private.txt', content: `token=${secret}` }), { type: 'done', finishReason: 'tool_calls' }], delivery(`Result ${secret}`)]);
    const events = await collect(executeTask({ ...options(runtime), task: `Keep credentials private: ${secret}` }));
    const id = events[0]!.sessionId;
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(await repository.events(id))).not.toContain(secret);
    expect(JSON.stringify(await repository.get(id))).not.toContain(secret);
    expect(JSON.stringify(runtime.requests)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(await readFile(join(directory, 'private.txt'), 'utf8')).toBe(`token=${secret}`);
  });
  it('plans and verifies two dependent tasks through real tool effects and ordered scheduling', async () => {
    await writeFile(join(directory, 'AGENTS.md'), 'Keep the existing exported interfaces.');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node verify.mjs' } }));
    await writeFile(join(directory, 'verify.mjs'), `import {readFileSync,existsSync} from 'node:fs';\nif(readFileSync('first.txt','utf8')!=='first') process.exitCode=1;\nif(existsSync('second.txt') && readFileSync('second.txt','utf8')!=='first+second') process.exitCode=1;\n`);
    const runtime = new ScriptedModel([delivery(JSON.stringify([{ id: 'first', title: 'Create first file', acceptance: ['First file has correct content'], dependsOn: [] }, { id: 'second', title: 'Create dependent second file', acceptance: ['Second file builds on first'], dependsOn: ['first'] }])), calls(tool('write_file', { path: 'first.txt', content: 'first' })), delivery('First step ready for verification'), calls(tool('read_file', { path: 'first.txt' }), tool('write_file', { path: 'second.txt', content: 'first+second' })), delivery('Second step ready for verification')]);
    const { plan: _explicitPlan, ...automatic } = options(runtime);
    void _explicitPlan;
    const events = await collect(executeTask({ ...automatic, permissions: 'full-access' }));
    const started = events.filter(event => event.type === 'task.started').map(event => event.payload);
    expect(started).toMatchObject([{ task: { id: 'first' } }, { task: { id: 'second' } }]);
    expect(events.filter(event => event.type === 'task.completed')).toHaveLength(2);
    expect(events.filter(event => event.type === 'verification.finished').every(event => typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) && event.payload['passed'] === true)).toBe(true);
    expect(events.at(-1)?.type).toBe('execution.completed');
    expect(events.at(-1)?.payload).toMatchObject({ tasks: [{ id: 'first', status: 'completed' }, { id: 'second', status: 'completed' }] });
    const firstCompleted = events.findIndex(event => event.type === 'task.completed');
    const secondStarted = events.findIndex((event, index) => index > firstCompleted && event.type === 'task.started');
    expect(firstCompleted).toBeGreaterThan(0); expect(secondStarted).toBeGreaterThan(firstCompleted);
    expect(runtime.requests[0]?.tools?.length ?? 0).toBe(0);
    expect(runtime.requests[0]?.messages[1]?.content).toContain('Keep the existing exported interfaces.');
    expect(runtime.requests[0]?.messages[1]?.content).toContain('node verify.mjs');
    const analysis = events.findIndex(event => event.type === 'project.analyzed');
    const planning = events.findIndex(event => event.type === 'task.planning');
    expect(analysis).toBeGreaterThan(0); expect(planning).toBeGreaterThan(analysis);
    expect(events.filter(event => event.type === 'tool.started' && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload) && event.payload['source'] === 'project-analysis').length).toBeGreaterThan(2);
    expect(await readFile(join(directory, 'first.txt'), 'utf8')).toBe('first');
    expect(await readFile(join(directory, 'second.txt'), 'utf8')).toBe('first+second');
  }, 120_000);
});
