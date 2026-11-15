import { Worker } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { ElvionError, validateEventSequence, type EventEnvelope } from '@elvion/kernel';
import { z } from 'zod';
import { SessionSnapshotSchema, type SessionSnapshot } from './schema.js';
export * from './schema.js';

export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env['ELVION_DATA_DIR'] ?? join(env['LOCALAPPDATA'] ?? join(homedir(), '.local', 'share'), 'Elvion');
}

export class SessionRepository {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #nextId = 1;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #failure: Error | undefined;
  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on('message', (raw: unknown) => {
      const reply = z.object({ id: z.number(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }).safeParse(raw);
      if (!reply.success) { this.#fail(new ElvionError('storage_error', 'Invalid storage worker response')); return; }
      const pending = this.#pending.get(reply.data.id);
      this.#pending.delete(reply.data.id);
      if (reply.data.ok) pending?.resolve(reply.data.value);
      else pending?.reject(new ElvionError('storage_error', reply.data.error ?? 'Storage request failed'));
    });
    worker.on('error', cause => this.#fail(new ElvionError('storage_error', 'Storage worker failed', { cause })));
    worker.on('exit', code => {
      if ((!this.#closing && !this.#closed) || code !== 0 || this.#pending.size) this.#fail(new ElvionError('storage_error', 'Storage worker exited unexpectedly'));
    });
  }
  static async open(filePath: string): Promise<SessionRepository> {
    await mkdir(dirname(filePath), { recursive: true });
    const js = new URL('./session-worker.js', import.meta.url);
    const development = new URL('../../../dist/session-worker.js', import.meta.url);
    const workerPath = existsSync(fileURLToPath(js)) ? js : development;
    if (!existsSync(fileURLToPath(workerPath))) throw new ElvionError('storage_error', 'Storage worker is missing. Run pnpm build.');
    return new SessionRepository(new Worker(workerPath, { workerData: filePath }));
  }
  async save(snapshot: SessionSnapshot, events: EventEnvelope[] = []): Promise<void> {
    await this.#request({ operation: 'save', snapshot: SessionSnapshotSchema.parse(snapshot), events });
  }
  async get(id: string): Promise<SessionSnapshot | undefined> {
    const value = await this.#request({ operation: 'get', sessionId: z.uuid().parse(id) });
    return value === null ? undefined : SessionSnapshotSchema.parse(value);
  }
  async list(): Promise<SessionSnapshot[]> { return z.array(SessionSnapshotSchema).parse(await this.#request({ operation: 'list' })); }
  async events(id: string): Promise<EventEnvelope[]> {
    const result = await this.#request({ operation: 'events', sessionId: z.uuid().parse(id) });
    if (!Array.isArray(result)) throw new ElvionError('storage_error', 'Invalid stored event collection');
    return validateEventSequence(result, { sessionId: id });
  }
  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.#closing = true;
    this.#closePromise = (async () => {
      try { if (!this.#failure) await this.#request({ operation: 'close' }, true); }
      finally { this.#closed = true; await this.#worker.terminate(); }
    })();
    return this.#closePromise;
  }
  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
  #request(request: Record<string, unknown>, duringClose = false): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed || (this.#closing && !duringClose)) return Promise.reject(new ElvionError('storage_error', 'Repository is closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#worker.postMessage({ ...request, id }); }
      catch (cause) { this.#pending.delete(id); reject(new ElvionError('storage_error', 'Cannot contact storage worker', { cause })); }
    });
  }
}
