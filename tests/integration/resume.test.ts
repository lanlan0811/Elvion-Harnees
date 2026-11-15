import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { executeTask, type ExecutionOptions } from '../../packages/execution/src/index.js';
import { SessionRepository, SessionSnapshotSchema, type SessionSnapshot } from '../../packages/session/src/index.js';
import { ElvionError, type EventEnvelope, type ModelEvent, type ModelRequest, type ModelRuntime } from '../../packages/kernel/src/index.js';

class Model implements ModelRuntime {
  readonly requests: ModelRequest[] = [];
  constructor(private turns: ModelEvent[][]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(request));
    const turn = this.turns.shift(); if (!turn) throw new ElvionError('model_error', 'Unexpected model replay');
    yield* turn;
  }
}
const delivery = (): ModelEvent[] => [{ type: 'text_delta', text: 'Ready for independent verification' }, { type: 'done', finishReason: 'stop' }];
const writes = (...names: string[]): ModelEvent[] => [...names.map(name => ({ type: 'tool_call' as const, call: { id: name, name: 'write_file', arguments: { path: name + '.txt', content: name } } })), { type: 'done', finishReason: 'tool_calls' }];
async function collect(events: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> { const result = []; for await (const event of events) result.push(event); return result; }

describe('durable execution checkpoint continuation', () => {
  let directory: string; let repository: SessionRepository;
  const plan = [{ id: 'first', title: 'First increment', dependsOn: [], acceptance: ['Project tests pass'] }, { id: 'second', title: 'Second increment', dependsOn: ['first'], acceptance: ['Project tests pass'] }];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elvion-resume-'));
    repository = await SessionRepository.open(join(directory, 'sessions.sqlite'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node check.mjs' } }));
    await writeFile(join(directory, 'check.mjs'), 'process.exitCode = 0;');
  });
  afterEach(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const options = (runtime: ModelRuntime): ExecutionOptions => ({ task: 'Original multi-step goal', workspace: directory, providerId: 'local-fixture', model: 'same-model', runtime, repository, permissions: 'full-access', plan, lockDirectory: join(directory, 'locks') });
  async function stopAt(input: ExecutionOptions, predicate: (event: EventEnvelope) => boolean): Promise<SessionSnapshot> {
    const iterator = executeTask(input)[Symbol.asyncIterator](); let id: string | undefined;
    try {
      while (true) { const next = await iterator.next(); if (next.done) throw new Error('Expected checkpoint event was not emitted'); id = next.value.sessionId; if (predicate(next.value)) break; }
    } finally { await iterator.return?.(); }
    const saved = await repository.get(id!); expect(saved).toBeDefined();
    await repository.close(); repository = await SessionRepository.open(join(directory, 'sessions.sqlite'));
    return (await repository.get(id!))!;
  }
  it('reopens SQLite and continues the next task without replanning or replaying a completed write', async () => {
    const first = new Model([writes('first'), delivery()]);
    const saved = await stopAt(options(first), event => event.type === 'task.completed');
    expect(saved.checkpoint).toMatchObject({ phase: 'between_tasks', safeToResume: true, tasks: [{ id: 'first', status: 'completed' }, { id: 'second', status: 'pending' }] });
    const second = new Model([writes('second'), delivery()]);
    const events = await collect(executeTask({ ...options(second), task: 'Must not replace saved goal', permissions: 'ask', session: saved }));
    expect(events.at(-1)?.type).toBe('execution.completed');
    expect(events.some(event => event.type === 'task.planning' || event.type === 'task.planned')).toBe(false);
    expect(events.find(event => event.type === 'task.started')?.payload).toMatchObject({ task: { id: 'second', status: 'running' } });
    expect(second.requests.every(request => Array.isArray(request.tools))).toBe(true);
    expect(JSON.stringify(second.requests)).toContain('Original multi-step goal');
    expect(JSON.stringify(second.requests)).not.toContain('Must not replace saved goal');
    const final = (await repository.get(saved.id))!;
    expect(final.task).toBe(saved.task); expect(final.permissions).toBe('full-access');
    expect(final.checkpoint!.budget.usage.turns).toBeGreaterThan(saved.checkpoint!.budget.usage.turns);
    expect(final.checkpoint!.tasks.every(task => task.status === 'completed')).toBe(true);
    expect(await readFile(join(directory, 'first.txt'), 'utf8')).toBe('first');
    const persisted = await repository.events(saved.id);
    expect(persisted.filter(event => event.type === 'tool.started' && JSON.stringify(event.payload).includes('first.txt'))).toHaveLength(1);
    expect(persisted.map(event => event.sequence)).toEqual(persisted.map((_event, index) => index + 1));
    const restored = new Model([]); const completed = await collect(executeTask({ ...options(restored), model: 'unconfigured-model', session: final }));
    expect(completed.map(event => event.type)).toEqual(['session.restored', 'execution.completed']); expect(restored.requests).toHaveLength(0);
  }, 120_000);
  it('continues a completed verification result without running the verification shell twice', async () => {
    const saved = await stopAt({ ...options(new Model([delivery()])), plan: plan.slice(0, 1) }, event => event.type === 'verification.finished');
    expect(saved.checkpoint?.phase).toBe('verification_result');
    const runtime = new Model([]); const events = await collect(executeTask({ ...options(runtime), session: saved }));
    expect(events.at(-1)?.type).toBe('execution.completed'); expect(runtime.requests).toHaveLength(0);
    expect(events.some(event => event.type === 'tool.started')).toBe(false);
    expect((await repository.events(saved.id)).filter(event => event.type === 'tool.started' && JSON.stringify(event.payload).includes('npm run test'))).toHaveLength(1);
  }, 120_000);
  it('retains the original verification baseline across restart and rejects a changed script', async () => {
    const saved = await stopAt(options(new Model([delivery()])), event => event.type === 'agent.delivery');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node replacement.mjs' } }));
    const runtime = new Model([]); const events = await collect(executeTask({ ...options(runtime), session: saved }));
    expect(events.at(-1)?.type).toBe('execution.needs_review'); expect(runtime.requests).toHaveLength(0);
    expect(events.at(-1)?.payload).toMatchObject({ error: { details: { requiresReview: true, changedScripts: ['test'] } } });
    expect((await repository.get(saved.id))?.checkpoint?.verificationBaseline?.scripts['test']).toBe('node check.mjs');
  });
  it('stops an incomplete tool batch after reopen without executing a pending or completed tool again', async () => {
    const saved = await stopAt(options(new Model([writes('once', 'pending')])), event => event.type === 'tool.finished' && JSON.stringify(event.payload).includes('once'));
    expect(saved.checkpoint?.safeToResume).toBe(false);
    const runtime = new Model([]); const events = await collect(executeTask({ ...options(runtime), session: saved }));
    expect(events.map(event => event.type)).toEqual(['execution.needs_review']); expect(runtime.requests).toHaveLength(0);
    expect(await readFile(join(directory, 'once.txt'), 'utf8')).toBe('once');
    await expect(readFile(join(directory, 'pending.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('restores exhausted turns and records failed task state instead of resetting its budget', async () => {
    const saved = await stopAt({ ...options(new Model([writes('once')])), budget: { maxTurns: 1 } }, event => event.type === 'tool.finished' && JSON.stringify(event.payload).includes('once'));
    expect(saved.checkpoint?.safeToResume).toBe(true);
    const runtime = new Model([]); const events = await collect(executeTask({ ...options(runtime), session: saved }));
    expect(runtime.requests).toHaveLength(0); expect(events.at(-1)?.type).toBe('execution.failed');
    expect(events.at(-1)?.payload).toMatchObject({ error: { code: 'budget_exceeded' }, budget: { turns: 1 } });
    expect(events.find(event => event.type === 'task.failed')?.payload).toMatchObject({ task: { id: 'first', status: 'failed' } });
    const stopped = (await repository.get(saved.id))!;
    expect(stopped.checkpoint?.tasks[0]?.status).toBe('failed');
    const restored = await collect(executeTask({ ...options(new Model([])), session: stopped }));
    expect(restored.map(event => event.type)).toEqual(['session.restored', 'execution.failed']);
    expect(restored.at(-1)?.payload).toMatchObject({ error: { code: 'budget_exceeded' }, budget: { turns: 1 } });
    await expect(collect(executeTask({ ...options(new Model([])), session: saved, budget: { maxTurns: 50 } }))).rejects.toMatchObject({ code: 'configuration_error' });
  });
  it('preserves repair counts across reopen and stops at the original two-repair ceiling', async () => {
    await writeFile(join(directory, 'check.mjs'), 'process.exitCode = 1;');
    const saved = await stopAt(options(new Model([delivery()])), event => event.type === 'execution.repair');
    expect(saved.checkpoint?.budget.usage.repairs).toBe(1);
    const runtime = new Model([delivery(), delivery()]); const events = await collect(executeTask({ ...options(runtime), session: saved }));
    expect(events.filter(event => event.type === 'execution.repair')).toHaveLength(1); expect(runtime.requests).toHaveLength(2);
    expect(events.at(-1)?.payload).toMatchObject({ budget: { repairs: 2 }, tasks: [{ id: 'first', status: 'failed' }, { id: 'second', status: 'pending' }] });
    expect((await repository.get(saved.id))?.state).toBe('failed');
  }, 120_000);
  it('rejects another model without writing events or resetting the saved checkpoint', async () => {
    const saved = await stopAt(options(new Model([])), event => event.type === 'task.started');
    await expect(collect(executeTask({ ...options(new Model([])), model: 'different-model', session: saved }))).rejects.toMatchObject({ code: 'configuration_error' });
    expect(await repository.get(saved.id)).toEqual(saved);
  });
  it('rejects inconsistent task phase baseline and forged verification results in persisted checkpoints', async () => {
    const saved = await stopAt(options(new Model([])), event => event.type === 'task.started');
    const variants = [
      { ...saved.checkpoint!, currentTaskId: 'missing-task' },
      { ...saved.checkpoint!, phase: 'verification_result' as const },
      { ...saved.checkpoint!, baselineCaptured: false },
      { ...saved.checkpoint!, phase: 'between_tasks' as const },
      { ...saved.checkpoint!, phase: 'verification_result' as const, lastReport: { passed: true, checks: [] } },
    ];
    for (const checkpoint of variants) {
      expect(SessionSnapshotSchema.safeParse({ ...saved, checkpoint }).success).toBe(false);
      await expect(repository.save({ ...saved, checkpoint })).rejects.toBeDefined();
    }
    expect(await repository.get(saved.id)).toEqual(saved);
  });
  it('rejects a completed snapshot label while its checkpoint still contains unverified running work', async () => {
    const saved = await stopAt(options(new Model([])), event => event.type === 'task.started');
    expect(SessionSnapshotSchema.safeParse({ ...saved, state: 'completed' }).success).toBe(false);
    await expect(repository.save({ ...saved, state: 'completed' })).rejects.toBeDefined();
    expect(await repository.get(saved.id)).toEqual(saved);
  });
  it('refuses fake legacy completion without an objectively verified completion event', async () => {
    const now = new Date().toISOString();
    const saved: SessionSnapshot = { schemaVersion: 1, id: crypto.randomUUID(), workspace: directory, providerId: 'local-fixture', permissions: 'ask', state: 'completed', task: 'Legacy unverified claim', messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
    await repository.save(saved);
    const runtime = new Model([]); const events = await collect(executeTask({ ...options(runtime), session: saved }));
    expect(events.map(event => event.type)).toEqual(['execution.needs_review']); expect(runtime.requests).toHaveLength(0);
    expect((await repository.get(saved.id))?.state).toBe('needs_review');
  });
  it('rejects an atomic save that rolls consumed budget counters backwards', async () => {
    const saved = await stopAt(options(new Model([writes('once')])), event => event.type === 'tool.finished' && JSON.stringify(event.payload).includes('once'));
    const lower = structuredClone(saved); lower.checkpoint!.budget.usage.turns = 0;
    await expect(repository.save(lower)).rejects.toMatchObject({ code: 'storage_error' });
    expect(await repository.get(saved.id)).toEqual(saved);
  });
  it('continues a stable checkpoint in a fresh Node process without repeating the previous process write', async () => {
    const root = resolve('.'); const helper = join(directory, 'resume-helper.mjs');
    const source = [
      'import {executeTask} from ' + JSON.stringify(join(root, 'packages/execution/src/index.ts')) + ';',
      'import {SessionRepository} from ' + JSON.stringify(join(root, 'packages/session/src/index.ts')) + ';',
      'import {join} from "node:path";',
      'const mode=process.argv[2]; const workspace=process.argv[3]; const repository=await SessionRepository.open(join(workspace,"sessions.sqlite"));',
      'const plan=' + JSON.stringify(plan) + '; let turns=0;',
      'const runtime={async *stream(request){if(!request.tools)throw new Error("Unexpected replan"); turns++; if(mode==="first"&&turns===1){yield {type:"tool_call",call:{id:"process-once",name:"write_file",arguments:{path:"process-once.txt",content:"once"}}};yield {type:"done",finishReason:"tool_calls"};}else{yield {type:"text_delta",text:"Ready for verification"};yield {type:"done",finishReason:"stop"};}}};',
      'const session=mode==="second"?(await repository.list())[0]:undefined;',
      'try{for await(const event of executeTask({task:"Original process goal",workspace,providerId:"process-fixture",model:"fixture",runtime,repository,permissions:"full-access",plan,lockDirectory:join(workspace,"locks"),...(session?{session}:{})})){if(mode==="first"&&event.type==="task.completed")break;}}finally{await repository.close();}',
      'console.log(JSON.stringify({turns,mode}));',
    ].join(String.fromCharCode(10));
    const workspacePlugin = { name: 'workspace', setup(builder: import('esbuild').PluginBuild) { builder.onResolve({ filter: new RegExp('^@elvion/') }, args => ({ path: resolve(root, 'packages', args.path.slice(8), 'src/index.ts') })); } };
    await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'resume-helper.ts' }, outfile: helper, bundle: true, platform: 'node', target: 'node24', format: 'esm', plugins: [workspacePlugin] });
    await build({ entryPoints: [join(root, 'packages/session/src/worker.ts')], outfile: join(directory, 'session-worker.js'), bundle: true, platform: 'node', target: 'node24', format: 'esm', plugins: [workspacePlugin] });
    await repository.close();
    const run = promisify(execFile);
    const first = await run(process.execPath, [helper, 'first', directory], { timeout: 60_000, windowsHide: true });
    const second = await run(process.execPath, [helper, 'second', directory], { timeout: 60_000, windowsHide: true });
    expect(JSON.parse(first.stdout)).toEqual({ turns: 2, mode: 'first' });
    expect(JSON.parse(second.stdout)).toEqual({ turns: 1, mode: 'second' });
    repository = await SessionRepository.open(join(directory, 'sessions.sqlite'));
    const saved = (await repository.list())[0]!;
    expect(saved.state).toBe('completed'); expect(saved.checkpoint?.budget.usage.turns).toBe(3);
    expect(saved.checkpoint?.tasks.map(task => task.status)).toEqual(['completed', 'completed']);
    expect((await repository.events(saved.id)).filter(event => event.type === 'tool.started' && JSON.stringify(event.payload).includes('process-once.txt'))).toHaveLength(1);
    expect(await readFile(join(directory, 'process-once.txt'), 'utf8')).toBe('once');
  }, 120_000);
  it('persists an unsafe consumed model request before yielding any response', async () => {
    let inspected: SessionSnapshot | undefined;
    const runtime: ModelRuntime = { async *stream(): AsyncIterable<ModelEvent> {
      inspected = (await repository.list())[0];
      expect(inspected?.checkpoint).toMatchObject({ safeToResume: false, budget: { usage: { turns: 1 } } });
      expect((await repository.events(inspected!.id)).at(-1)?.type).toBe('model.requested');
      yield* delivery();
    } };
    const events = await collect(executeTask({ ...options(runtime), plan: plan.slice(0, 1) }));
    expect(inspected).toBeDefined(); expect(events.at(-1)?.type).toBe('execution.completed');
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
  }, 120_000);
  it('restores cumulative retry consumption instead of granting two new retries', async () => {
    const fail: ModelRuntime = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new ElvionError('model_error', 'Temporary outage', { retryable: true }); } }) }) };
    const saved = await stopAt(options(fail), event => event.type === 'execution.retry');
    expect(saved.checkpoint?.budget.usage.retries).toBe(1);
    const events = await collect(executeTask({ ...options(fail), session: saved }));
    expect(events.filter(event => event.type === 'execution.retry')).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({ budget: { retries: 2 }, tasks: [{ id: 'first', status: 'failed' }, { id: 'second', status: 'pending' }] });
  });
});
