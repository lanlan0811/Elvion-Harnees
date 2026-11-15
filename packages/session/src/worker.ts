import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryRequestSchema, SessionSnapshotSchema } from './schema.js';
import { validateEventSequence } from '@elvion/kernel';
import { initializeDatabase } from './database.js';

if (!parentPort || typeof workerData !== 'string') throw new Error('Invalid storage worker initialization');
const port = parentPort;
const db = new DatabaseSync(workerData);
await initializeDatabase(db);
port.on('message', (raw: unknown) => {
  const parsed = RepositoryRequestSchema.safeParse(raw);
  if (!parsed.success) { port.postMessage({ id: typeof raw === 'object' && raw !== null && 'id' in raw ? raw.id : -1, ok: false, error: 'Invalid repository request' }); return; }
  const request = parsed.data;
  try {
    let value: unknown;
    if (request.operation === 'save') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(request.snapshot.id);
        const previous = old ? SessionSnapshotSchema.parse(JSON.parse(String(old['snapshot']))) : undefined;
        const storedSequence = db.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE session_id=?').get(request.snapshot.id)?.['sequence'];
        if (Number(storedSequence ?? 0) !== (previous?.lastSequence ?? 0)) throw new Error('Stored event history and snapshot are inconsistent');
        const events = validateEventSequence(request.events, { sessionId: request.snapshot.id, previousSequence: previous?.lastSequence ?? 0 });
        if (request.snapshot.lastSequence !== (events.at(-1)?.sequence ?? previous?.lastSequence ?? 0)) throw new Error('Snapshot sequence does not match events');
        if (previous && (previous.workspace !== request.snapshot.workspace || previous.createdAt !== request.snapshot.createdAt || previous.providerId !== request.snapshot.providerId || previous.task !== request.snapshot.task)) throw new Error('Immutable session identity changed');
        if (previous && previous.permissions !== request.snapshot.permissions) {
          const authorized = events.some(event => { const payload = event.payload; return event.type === 'session.permissions_changed' && payload !== null && typeof payload === 'object' && !Array.isArray(payload) && payload['source'] === 'user' && payload['previous'] === previous.permissions && payload['permissions'] === request.snapshot.permissions; });
          if (!authorized) throw new Error('Permission changes require an explicit user audit event');
        }
        if (previous && request.snapshot.updatedAt < previous.updatedAt) throw new Error('Session update time moved backwards');
        if (previous?.checkpoint) {
          const before = previous.checkpoint; const after = request.snapshot.checkpoint;
          if (!after || before.model !== after.model || JSON.stringify(before.budget.limits) !== JSON.stringify(after.budget.limits)) throw new Error('Execution checkpoint identity changed');
          for (const counter of ['turns', 'toolCalls', 'retries', 'repairs', 'elapsedMs'] as const) if (after.budget.usage[counter] < before.budget.usage[counter]) throw new Error('Execution budget moved backwards');
        }
        for (const event of events) db.prepare('INSERT INTO events VALUES(?,?,?)').run(event.sessionId, event.sequence, JSON.stringify(event));
        db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,snapshot=excluded.snapshot').run(request.snapshot.id, request.snapshot.updatedAt, JSON.stringify(request.snapshot));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      value = true;
    } else if (request.operation === 'get') {
      const row = db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(request.sessionId);
      value = row ? JSON.parse(String(row['snapshot'])) : null;
    } else if (request.operation === 'list') {
      value = db.prepare('SELECT snapshot FROM sessions ORDER BY updated DESC').all().map(row => JSON.parse(String(row['snapshot'])) as unknown);
    } else if (request.operation === 'events') {
      value = db.prepare('SELECT event FROM events WHERE session_id=? ORDER BY sequence').all(request.sessionId).map(row => JSON.parse(String(row['event'])) as unknown);
    } else { db.close(); value = true; }
    port.postMessage({ id: request.id, ok: true, value });
    if (request.operation === 'close') port.close();
  } catch { port.postMessage({ id: request.id, ok: false, error: 'Storage transaction failed or data is incompatible' }); }
});
