import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventSequencer, serializeError } from '@elvion/kernel';
import { initializeDatabase, isSqliteContention } from './database.js';
import { SessionRepository, type SessionSnapshot } from './index.js';

describe('SQLite initialization contention', () => {
  it('classifies only actual SQLite BUSY/LOCKED result codes as retryable initialization', () => {
    expect(isSqliteContention({ errcode: 5 })).toBe(true);
    expect(isSqliteContention({ errcode: 6 + 256 })).toBe(true);
    expect(isSqliteContention({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isSqliteContention({ message: 'database is locked' })).toBe(false);
    expect(isSqliteContention({ errcode: 11 })).toBe(false);
  });

  it('retries safe initialization after an actual SQLite write-lock conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvion-db-lock-'));
    const path = join(directory, 'db.sqlite');
    const blocker = new DatabaseSync(path); const contender = new DatabaseSync(path);
    try {
      blocker.exec('CREATE TABLE lock_fixture (id INTEGER); BEGIN EXCLUSIVE;');
      let released = false;
      const timer = setTimeout(() => { blocker.exec('COMMIT'); released = true; }, 30);
      try { await initializeDatabase(contender); } finally { clearTimeout(timer); if (!released) blocker.exec('ROLLBACK'); }
      expect(contender.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1);
      expect(contender.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
      expect(contender.prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(5000);
    } finally { contender.close(); blocker.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('starts multiple workers against fresh databases and accepts exactly one competing event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvion-db-race-'));
    try {
      for (let round = 0; round < 4; round += 1) {
        const path = join(directory, 'round-' + round + '.sqlite');
        const repositories = await Promise.all(Array.from({ length: 4 }, () => SessionRepository.open(path)));
        try {
          const first = repositories[0]!; const now = new Date().toISOString();
          const state: SessionSnapshot = { schemaVersion: 1, id: randomUUID(), workspace: directory, providerId: 'fixture', permissions: 'ask', state: 'created', task: 'Initialize', messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
          await first.save(state);
          const event = new EventSequencer({ sessionId: state.id }).next('execution.started', {});
          const results = await Promise.allSettled(repositories.map(repository => repository.save({ ...state, lastSequence: 1 }, [event])));
          expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter(result => result.status === 'rejected')).toHaveLength(3);
          expect(await first.events(state.id)).toEqual([event]);
          await Promise.all(repositories.map(async repository => { expect((await repository.get(state.id))?.lastSequence).toBe(1); }));
        } finally { await Promise.all(repositories.map(repository => repository.close())); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('retains worker startup causes locally without serializing raw database errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvion-db-version-')); const path = join(directory, 'future.sqlite');
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=999;'); db.close();
    const repository = await SessionRepository.open(path);
    try {
      let failure: unknown;
      try { await repository.list(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'storage_error', cause: expect.any(Error) });
      expect(JSON.stringify(serializeError(failure))).not.toContain('Unsupported session database version');
      expect(JSON.stringify(serializeError(failure))).not.toContain(path);
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
