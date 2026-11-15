import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';

export function isSqliteContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('errcode' in error && typeof error.errcode === 'number') return [5, 6].includes(error.errcode & 0xff);
  return 'code' in error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
}

/** Retry only idempotent initialization; never replay tool operations or session saves. */
export async function initializeDatabase(db: DatabaseSync): Promise<void> {
  db.exec('PRAGMA busy_timeout=1000;');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let transaction = false;
    try {
      const journalMode = db.prepare('PRAGMA journal_mode').get()?.['journal_mode'];
      if (journalMode !== 'wal') db.exec('PRAGMA journal_mode=WAL;');
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      const version = db.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version !== 0 && version !== 1) throw new Error('Unsupported session database version');
      db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, updated TEXT NOT NULL, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id,sequence)); PRAGMA user_version=1;');
      db.exec('COMMIT'); transaction = false;
      db.exec('PRAGMA busy_timeout=5000;');
      return;
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      if (!isSqliteContention(error) || attempt === 7) throw error;
      await setTimeout(Math.min(250, 50 * 2 ** attempt));
    }
  }
}
