import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseSessionLocks } from '../cli/doctor.js';
const roots: string[] = [];
async function setup() { const home = await mkdtemp(join(tmpdir(), 'elvion-doctor-')); roots.push(home); const dir = join(home, 'sessions', randomUUID()); await mkdir(dir, { recursive: true }); return { home, dir }; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('read-only session lock diagnostics', () => {
  it('reports a lock claim and provides manual recovery without removing anything', async () => {
    const { home, dir } = await setup(); const guard = join(dir, 'lock-claim'); await mkdir(guard);
    const checks = await diagnoseSessionLocks(home);
    expect(checks.some(check => check.state === '失败' && check.details.includes(guard))).toBe(true);
    expect(checks.map(check => check.details).join(' ')).toContain('关闭所有 ELVION 进程');
    expect((await stat(guard)).isDirectory()).toBe(true);
  });
  it('reports malformed JSON without modifying the lock', async () => {
    const { home, dir } = await setup(); const lock = join(dir, 'lock.json'); await writeFile(lock, '{broken');
    expect((await diagnoseSessionLocks(home)).some(check => check.state === '失败' && check.details.includes(lock))).toBe(true);
    expect(await readFile(lock, 'utf8')).toBe('{broken');
  });
  it.each([null,0,-1,'123'])('reports an invalid lock PID unchanged: %s', async pid => {
    const { home, dir } = await setup(); const lock = join(dir, 'lock.json'); const value = JSON.stringify({ pid, token: randomUUID() }); await writeFile(lock, value);
    expect((await diagnoseSessionLocks(home)).some(check => check.state === '失败' && check.details.includes(lock))).toBe(true);
    expect(await readFile(lock, 'utf8')).toBe(value);
  });
  it('accepts a structurally valid lock without claiming its session is recoverable', async () => {
    const { home, dir } = await setup(); await writeFile(join(dir, 'lock.json'), JSON.stringify({ pid: process.pid, token: randomUUID() }));
    const checks = await diagnoseSessionLocks(home); expect(checks.every(check => check.state !== '失败')).toBe(true); expect(checks[0]?.details).toContain('不代表');
  });
  it('marks missing session storage unverified without creating it', async () => {
    const { home } = await setup(); const missing = join(home, 'absent'); expect((await diagnoseSessionLocks(missing))[0]?.state).toBe('未验证'); await expect(stat(missing)).rejects.toThrow();
  });
});
