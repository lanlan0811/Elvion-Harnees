import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionRepository, SessionSnapshotSchema } from '../../packages/session/src/index.js';
import type { SessionSnapshot } from '../../packages/session/src/index.js';
import { EventSequencer } from '../../packages/kernel/src/index.js';

describe('worker SQLite session transactions', () => {
  let directory: string;
  const repositories: SessionRepository[] = [];
  const openRepository = async () => { const repository = await SessionRepository.open(join(directory, 'sessions.sqlite')); repositories.push(repository); return repository; };
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'elvion-session-')); });
  afterEach(async () => { await Promise.all(repositories.splice(0).map(repository => repository.close())); await rm(directory, { recursive: true, force: true }); });
  function snapshot(): SessionSnapshot {
    const now = new Date().toISOString();
    return { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'local-fixture', permissions: 'ask', state: 'created', task: '恢复会话', messages: [{ role: 'user', content: '保留中文和 CRLF\r\n第二行' }], lastSequence: 0, createdAt: now, updatedAt: now };
  }
  it('persists original messages, permissions and ordered events across worker restart', async () => {
    const first = await openRepository(); const state = snapshot();
    const sequence = new EventSequencer({ sessionId: state.id });
    const started = sequence.next('execution.started', { task: state.task });
    const tool = sequence.next('tool.started', { id: 'write-1', name: 'write_file', arguments: { path: '中文.txt', content: 'value' } });
    state.state = 'running'; state.lastSequence = 2;
    await first.save(state, [started, tool]);
    await first.close();
    const reopened = await openRepository();
    expect(await reopened.get(state.id)).toEqual(state);
    expect(await reopened.events(state.id)).toEqual([started, tool]);
    expect(await reopened.list()).toEqual([state]);
    expect((await readFile(join(directory, 'sessions.sqlite'))).subarray(0, 16).toString()).toBe('SQLite format 3\0');
    const continuation = new EventSequencer({ sessionId: state.id, nextSequence: state.lastSequence + 1 });
    const review = continuation.next('execution.needs_review', { reason: '结果不明，先核实' });
    const reviewed = { ...state, state: 'needs_review' as const, lastSequence: review.sequence };
    await reopened.save(reviewed, [review]);
    expect((await reopened.events(state.id)).map(event => event.sequence)).toEqual([1, 2, 3]);
    expect((await reopened.get(state.id))?.permissions).toBe('ask');
  });
  it('rejects duplicate and gapped sequences atomically without corrupting snapshots', async () => {
    const repository = await openRepository(); const state = snapshot();
    const sequence = new EventSequencer({ sessionId: state.id });
    const first = sequence.next('execution.started', {});
    state.lastSequence = 1; await repository.save(state, [first]);
    await expect(repository.save({ ...state, state: 'completed' }, [first])).rejects.toMatchObject({ code: 'storage_error' });
    const third = new EventSequencer({ sessionId: state.id, nextSequence: 3 }).next('execution.completed', {});
    await expect(repository.save({ ...state, lastSequence: 3 }, [third])).rejects.toMatchObject({ code: 'storage_error' });
    expect(await repository.get(state.id)).toEqual(state);
    expect(await repository.events(state.id)).toEqual([first]);
    const second = sequence.next('execution.failed', { reason: 'fixture' });
    await repository.save({ ...state, state: 'failed', lastSequence: 2 }, [second]);
    expect((await repository.events(state.id)).map(event => event.sequence)).toEqual([1, 2]);
  });
  it('serializes competing writers with exactly one accepted next event', async () => {
    const left = await openRepository(); const right = await openRepository(); const state = snapshot();
    await left.save(state);
    const event = new EventSequencer({ sessionId: state.id }).next('execution.started', {});
    const result = await Promise.allSettled([left.save({ ...state, lastSequence: 1 }, [event]), right.save({ ...state, lastSequence: 1 }, [event])]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(await left.events(state.id)).toEqual([event]);
  });
  it('rejects identity changes, malformed records and requests after close', async () => {
    const repository = await openRepository(); const state = snapshot(); await repository.save(state);
    await expect(repository.save({ ...state, workspace: join(directory, 'different') })).rejects.toMatchObject({ code: 'storage_error' });
    await expect(repository.save({ ...state, providerId: 'different-provider' })).rejects.toMatchObject({ code: 'storage_error' });
    await expect(repository.save({ ...state, task: 'injected task' })).rejects.toMatchObject({ code: 'storage_error' });
    await expect(repository.save({ ...state, permissions: 'full-access' })).rejects.toMatchObject({ code: 'storage_error' });
    expect(await repository.get(state.id)).toEqual(state);
    expect(SessionSnapshotSchema.safeParse({ ...state, schemaVersion: 999 }).success).toBe(false);
    expect(SessionSnapshotSchema.safeParse({ ...state, permissions: 'root' }).success).toBe(false);
    expect(await repository.get(randomUUID())).toBeUndefined();
    await repository.close();
    await expect(repository.get(state.id)).rejects.toMatchObject({ code: 'storage_error' });
  });
  it('allows permission changes only with the correlated explicit user audit event', async () => {
    const repository = await openRepository(); const state = snapshot(); await repository.save(state);
    const event = new EventSequencer({ sessionId: state.id }).next('session.permissions_changed', { previous: 'ask', permissions: 'auto-edit', source: 'user' });
    await repository.save({ ...state, permissions: 'auto-edit', lastSequence: event.sequence, updatedAt: event.timestamp }, [event]);
    expect((await repository.get(state.id))?.permissions).toBe('auto-edit');
    expect(await repository.events(state.id)).toEqual([event]);
  });
  it('closes concurrently without accepting writes after close begins', async () => {
    const repository = await openRepository(); const state = snapshot(); await repository.save(state);
    const firstClose = repository.close();
    const secondClose = repository.close();
    await expect(repository.save(state)).rejects.toMatchObject({ code: 'storage_error' });
    await Promise.all([firstClose, secondClose]);
    const reopened = await openRepository(); expect(await reopened.get(state.id)).toEqual(state);
  });
});
