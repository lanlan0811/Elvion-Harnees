import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, appendFile, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../runtime/session.js';
const dirs: string[] = []; const stores: SessionStore[] = [];
async function setup() { const home = await mkdtemp(join(tmpdir(), 'elvion-session-')); dirs.push(home); const store = await SessionStore.create(home, home); stores.push(store); return { home, store }; }
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
describe('持久会话', () => {
  it('追加、独占锁、关闭后恢复原会话，未知工具不会丢失', async () => { const { home, store } = await setup(); await store.append('title', '中文会话'); await store.append('tool-start', { id: 't1', name: 'bash', arguments: { command: 'echo test' } }); await expect(SessionStore.resume(store.info.id, home)).rejects.toThrow('使用'); await store.close(); const resumed = await SessionStore.resume(store.info.id, home); stores.push(resumed); expect(resumed.info.title).toBe('中文会话'); expect(resumed.unfinishedTools()[0]?.id).toBe('t1'); expect((await SessionStore.list(home))[0]?.locked).toBe(true); });
  it('末尾半条记录可恢复并记录修复，不影响完整记录', async () => { const { home, store } = await setup(); await store.append('title', 'keep'); await store.close(); await appendFile(join(store.dir, 'events.jsonl'), '{partial'); const resumed = await SessionStore.resume(store.info.id, home); stores.push(resumed); expect(resumed.events.at(-1)?.type).toBe('recovery'); expect(resumed.info.title).toBe('keep'); expect(await readFile(join(store.dir, 'events.jsonl'), 'utf8')).not.toContain('{partial'); });
  it('中间完整记录损坏时拒绝恢复且释放锁', async () => { const { home, store } = await setup(); await store.close(); const path = join(store.dir, 'events.jsonl'); const original = await readFile(path, 'utf8'); await writeFile(path, original.replace('新会话', '已篡改')); await expect(SessionStore.resume(store.info.id, home)).rejects.toThrow('损坏'); await expect(readFile(join(store.dir, 'lock.json'))).rejects.toThrow(); });
  it('拒绝路径注入会话ID', async () => { const { home } = await setup(); await expect(SessionStore.resume('../evil', home)).rejects.toThrow('无效'); });
  it('两个恢复者争抢过期锁时只允许一个持有者', async () => { const { home, store } = await setup(); await store.close(); await writeFile(join(store.dir, 'lock.json'), JSON.stringify({ pid: 2147483647, token: randomUUID() })); const outcomes = await Promise.allSettled([SessionStore.resume(store.info.id, home), SessionStore.resume(store.info.id, home)]); const acquired = outcomes.filter((r): r is PromiseFulfilledResult<SessionStore> => r.status === 'fulfilled'); expect(acquired).toHaveLength(1); stores.push(acquired[0]!.value); const lock = JSON.parse(await readFile(join(store.dir, 'lock.json'), 'utf8')); expect(lock.pid).toBe(process.pid); });
  it('损坏PID锁拒绝回收而非假装过期', async () => { const { home, store } = await setup(); await store.close(); await writeFile(join(store.dir, 'lock.json'), JSON.stringify({ pid: null, token: 'bad' })); await expect(SessionStore.resume(store.info.id, home)).rejects.toThrow('锁损坏'); });
});
