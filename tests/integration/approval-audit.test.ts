import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTask, type ExecutionOptions } from '../../packages/execution/src/index.js';
import { SessionRepository } from '../../packages/session/src/index.js';
import { ElvionError, type ApprovalHandler, type EventEnvelope, type ModelEvent, type ModelRuntime } from '../../packages/kernel/src/index.js';

describe('durable approval audit correlation', () => {
  let directory: string; let repository: SessionRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elvion-approval-audit-')); repository = await SessionRepository.open(join(directory, 'sessions.sqlite'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
    await writeFile(join(directory, 'check.mjs'), 'process.exitCode = 0;');
  });
  afterEach(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const options = (approve?: ApprovalHandler) => {
    let turn = 0;
    const runtime: ModelRuntime = { async *stream(): AsyncIterable<ModelEvent> { turn++; if (turn === 1) { yield { type: 'tool_call', call: { id: 'write-once', name: 'write_file', arguments: { path: 'approved.txt', content: 'approved' } } }; yield { type: 'done', finishReason: 'tool_calls' }; } else { yield { type: 'text_delta', text: 'Ready for verification' }; yield { type: 'done', finishReason: 'stop' }; } } };
    return { task: 'Write one file', workspace: directory, providerId: 'fixture', model: 'fixture', runtime, repository, permissions: 'ask' as const, plan: [{ id: 'coding', title: 'Write file', acceptance: ['Project check passes'] }], lockDirectory: join(directory, 'locks'), ...(approve ? { approve } : {}) };
  };
  async function collect(input: ExecutionOptions): Promise<EventEnvelope[]> { const events = []; for await (const event of executeTask(input)) events.push(event); return events; }
  it('persists matching request and decision before baseline model tool and verification effects', async () => {
    const events = await collect(options(async request => ({ requestId: request.id, decision: 'approved' })));
    expect(events.at(-1)?.type).toBe('execution.completed');
    const requests = events.filter(event => event.type === 'approval.requested'); const decisions = events.filter(event => event.type === 'approval.decided');
    expect(requests.length).toBeGreaterThanOrEqual(4); expect(decisions).toHaveLength(requests.length);
    for (let index = 0; index < requests.length; index++) {
      expect(requests[index]?.payload).toMatchObject({ workspace: await realpath(directory), cwd: await realpath(directory) });
      expect(decisions[index]?.payload).toMatchObject({ id: (requests[index]!.payload as {id:string}).id, requestId: (requests[index]!.payload as {id:string}).id, decision: 'approved', matched: true });
      expect(decisions[index]!.sequence).toBe(requests[index]!.sequence + 1);
    }
    expect(await readFile(join(directory, 'approved.txt'), 'utf8')).toBe('approved');
    expect((await repository.events(events[0]!.sessionId)).map(event => event.sequence)).toEqual(events.map(event => event.sequence));
  }, 120_000);
  it.each(['denied', 'cancelled', 'mismatched'] as const)('records %s with its request ID and never executes the pending write', async mode => {
    const events = await collect(options(async request => request.toolCall.name === 'write_file' ? { requestId: mode === 'mismatched' ? 'wrong-request' : request.id, decision: mode === 'mismatched' ? 'approved' : mode } : { requestId: request.id, decision: 'approved' }));
    expect(events.at(-1)?.type).toBe(mode === 'cancelled' ? 'execution.cancelled' : 'execution.failed');
    const request = events.find(event => event.type === 'approval.requested' && JSON.stringify(event.payload).includes('write-once'))!;
    expect(events.find(event => event.type === 'approval.decided' && (event.payload as {id:string}).id === (request.payload as {id:string}).id)?.payload).toMatchObject({ decision: mode === 'mismatched' ? 'approved' : mode, matched: mode !== 'mismatched' });
    await expect(readFile(join(directory, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists awaiting approval as unsafe and cancels its decision before any side effect', async () => {
    const controller = new AbortController(); let waitingId = '';
    const input = options(async (request, pending) => {
      if (request.toolCall.name !== 'write_file') return { requestId: request.id, decision: 'approved' };
      const saved = (await repository.list())[0]!; waitingId = saved.id;
      expect(saved.state).toBe('awaiting_approval'); expect(saved.checkpoint?.safeToResume).toBe(false);
      controller.abort(new ElvionError('cancelled', 'Cancel waiting approval'));
      return await new Promise((_resolve, reject) => { if (pending.signal.aborted) reject(pending.signal.reason); else pending.signal.addEventListener('abort', () => reject(pending.signal.reason), { once: true }); });
    });
    const events = await collect({ ...input, signal: controller.signal });
    expect(events.at(-1)?.type).toBe('execution.cancelled');
    expect(events.filter(event => event.type === 'approval.decided').at(-1)?.payload).toMatchObject({ decision: 'cancelled' });
    expect(waitingId).not.toBe('');
    await expect(readFile(join(directory, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires review after reopening a saved pending approval without approving or replaying it', async () => {
    let pendingSnapshot: Awaited<ReturnType<SessionRepository['get']>>;
    const controller = new AbortController();
    const input = options(async (request, pending) => {
      pendingSnapshot = (await repository.list())[0]; controller.abort();
      return await new Promise((_resolve, reject) => { if (pending.signal.aborted) reject(pending.signal.reason); else pending.signal.addEventListener('abort', () => reject(pending.signal.reason), { once: true }); });
    });
    await collect({ ...input, signal: controller.signal });
    expect(pendingSnapshot?.state).toBe('awaiting_approval');
    let isolated = await SessionRepository.open(join(directory, 'pending.sqlite'));
    try {
      const history = await repository.events(pendingSnapshot!.id);
      const original = history.filter(event => event.sequence <= pendingSnapshot!.lastSequence);
      await isolated.save(pendingSnapshot!, original);
      await isolated.close(); isolated = await SessionRepository.open(join(directory, 'pending.sqlite'));
      const events = await collect({ ...options(), repository: isolated, session: pendingSnapshot!, lockDirectory: join(directory, 'pending-locks') });
      expect(events.map(event => event.type)).toEqual(['execution.needs_review']);
      expect((await isolated.get(pendingSnapshot!.id))?.state).toBe('needs_review');
    } finally { await isolated.close(); }
  });
  it('does not invent a user decision when no interactive approver exists', async () => {
    const events = await collect(options());
    expect(events.at(-1)?.type).toBe('execution.approval_required');
    expect(events.some(event => event.type === 'approval.decided')).toBe(false);
  });
});
