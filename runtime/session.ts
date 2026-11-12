import { mkdir, readFile, open, readdir, stat, unlink, rename, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getAppHome } from '../core/config.js';
import type { Message, SessionInfo, TranscriptEntry, TodoItem } from '../core/types.js';
export interface SessionEvent { seq: number; type: string; timestamp: string; data: unknown; previousHash: string; hash: string }
export interface PersistedState { messages: Message[]; entries: TranscriptEntry[]; profileId?: string; profileFingerprint?: string; todos: TodoItem[] }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
function validId(id: string): boolean { return /^[a-f0-9-]{36}$/.test(id); }
export class SessionStore {
  readonly dir: string; info: SessionInfo; events: SessionEvent[] = [];
  private handle?: FileHandle; private lockToken = randomUUID(); private queue: Promise<unknown> = Promise.resolve(); private lockHeld = false;
  private constructor(dir: string, info: SessionInfo) { this.dir = dir; this.info = info; }
  static async create(cwd: string, home = getAppHome()): Promise<SessionStore> {
    const actual = await realpath(cwd); if (!(await stat(actual)).isDirectory()) throw new Error('工作目录无效');
    const id = randomUUID(); const now = new Date().toISOString(); const dir = join(home, 'sessions', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const store = new SessionStore(dir, { id, title: '新会话', cwd: actual, createdAt: now, updatedAt: now, locked: true });
    await store.acquire(); await store.append('session-created', { ...store.info, locked: false }); return store;
  }
  static async resume(id?: string, home = getAppHome()): Promise<SessionStore> {
    if (!id) id = (await SessionStore.list(home)).find(s => !s.locked)?.id;
    if (!id || !validId(id)) throw new Error('没有可恢复会话或会话 ID 无效');
    const dir = join(home, 'sessions', id); const store = new SessionStore(dir, {} as SessionInfo);
    await store.acquire();
    try {
      const raw = await readFile(join(dir, 'events.jsonl'), 'utf8'); const split = raw.split('\n');
      const complete = raw.endsWith('\n') ? split.slice(0, -1) : split.slice(0, -1);
      let previousHash = '';
      for (const line of complete) {
        if (!line) throw new Error('会话记录存在空行');
        const event = JSON.parse(line) as SessionEvent; const { hash: recordedHash, ...base } = event;
        if (event.seq !== store.events.length + 1 || event.previousHash !== previousHash || recordedHash !== hash(base)) throw new Error('会话完整记录损坏，拒绝覆盖');
        store.events.push(event); previousHash = recordedHash;
      }
      const first = store.events[0]; if (first?.type !== 'session-created') throw new Error('会话头损坏');
      const meta = first.data as SessionInfo; if (meta.id !== id) throw new Error('会话 ID 与记录不匹配');
      if (!(await stat(meta.cwd)).isDirectory()) throw new Error('原工作目录不可用：' + meta.cwd);
      store.info = { ...meta, locked: true, updatedAt: store.events.at(-1)?.timestamp || meta.createdAt };
      const title = store.events.filter(e => e.type === 'title').at(-1); if (title) store.info.title = String(title.data);
      if (!raw.endsWith('\n')) {
        await store.handle?.close();
        const repair = await open(join(dir, 'events.jsonl'), 'r+');
        try { await repair.truncate(Buffer.byteLength(complete.join('\n') + (complete.length ? '\n' : ''), 'utf8')); await repair.sync(); } finally { await repair.close(); }
        store.handle = await open(join(dir, 'events.jsonl'), 'a+', 0o600);
        await store.append('recovery', { reason: '忽略并移除末尾未完成记录' });
      }
      return store;
    } catch (e) { await store.close(); throw e; }
  }
  static async list(home = getAppHome()): Promise<SessionInfo[]> {
    let names: string[]; try { names = await readdir(join(home, 'sessions')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const result: SessionInfo[] = [];
    for (const id of names.filter(validId)) {
      try {
        const raw = await readFile(join(home, 'sessions', id, 'events.jsonl'), 'utf8');
        const lines = raw.split('\n').filter(Boolean); const first = JSON.parse(lines[0] || '') as SessionEvent;
        if (first.type !== 'session-created') continue; const info = first.data as SessionInfo;
        let title = info.title; let updatedAt = info.createdAt;
        for (const line of lines.slice(1)) { try { const e = JSON.parse(line) as SessionEvent; if (e.type === 'title') title = String(e.data); updatedAt = e.timestamp; } catch { break; } }
        let locked = false; try { const lock = JSON.parse(await readFile(join(home, 'sessions', id, 'lock.json'), 'utf8')); locked = alive(Number(lock.pid)); } catch { /* no lock */ }
        result.push({ ...info, id, title, updatedAt, locked });
      } catch { /* corrupted sessions are not silently resumed */ }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async acquire(): Promise<void> {
    const path = join(this.dir, 'lock.json'); await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Serialize both fresh acquisition and stale reclamation. Never rename a lock
    // observed before another contender installed a new token. A crashed guard
    // fails closed and requires diagnosis instead of risking two writers.
    const guard = join(this.dir, 'lock-claim');
    try { await mkdir(guard); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('会话锁正被获取或需要诊断，请稍后重试'); throw e; }
    try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const lock = await open(path, 'wx', 0o600); try { await lock.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); await lock.sync(); } finally { await lock.close(); } this.lockHeld = true; this.handle = await open(join(this.dir, 'events.jsonl'), 'a+', 0o600); return; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { if (this.lockHeld) await this.close(); throw e; }
        let old: { pid: number; token: string }; try { old = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('会话锁不可读，拒绝抢占'); }
        if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== 'string' || !/^[a-f0-9-]{36}$/.test(old.token)) throw new Error('会话锁损坏，拒绝抢占');
        if (alive(old.pid)) throw new Error('会话正被进程 ' + old.pid + ' 使用');
        const stale = path + '.' + randomUUID() + '.stale';
        try { await rename(path, stale); await unlink(stale); } catch { throw new Error('会话锁发生竞争，请重试'); }
      }
    }
    throw new Error('无法取得会话锁');
    } finally { const { rmdir } = await import('node:fs/promises'); await rmdir(guard); }
  }
  append(type: string, data: unknown): Promise<void> {
    const work = this.queue.then(async () => {
      if (!this.handle) throw new Error('会话已关闭');
      const base = { seq: this.events.length + 1, type, timestamp: new Date().toISOString(), data, previousHash: this.events.at(-1)?.hash || '' };
      const event: SessionEvent = { ...base, hash: hash(base) };
      await this.handle.write(JSON.stringify(event) + '\n'); await this.handle.sync(); this.events.push(event); this.info.updatedAt = event.timestamp;
      if (type === 'title') this.info.title = String(data);
    });
    this.queue = work; return work;
  }
  latestState(): PersistedState | undefined { return this.events.filter(e => e.type === 'state').at(-1)?.data as PersistedState | undefined; }
  unfinishedTools(): { id: string; name: string; arguments: Record<string, unknown> }[] {
    const pending = new Map<string, { id: string; name: string; arguments: Record<string, unknown> }>();
    for (const e of this.events) { if (e.type === 'tool-start') { const call = e.data as { id: string; name: string; arguments: Record<string, unknown> }; pending.set(call.id, call); } if (e.type === 'tool-end') pending.delete((e.data as { id: string }).id); } return [...pending.values()];
  }
  async close(): Promise<void> {
    await this.queue.catch(() => undefined); const handle = this.handle; this.handle = undefined; await handle?.close();
    if (this.lockHeld) try { const path = join(this.dir, 'lock.json'); const lock = JSON.parse(await readFile(path, 'utf8')); if (lock.token === this.lockToken) await unlink(path); } catch { /* lock already removed */ } finally { this.lockHeld = false; }
  }
}
