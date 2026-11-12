import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getAppHome } from '../core/config.js';

export interface DiagnosticCheck { name: string; state: '通过' | '失败' | '未验证'; details: string }
const manual = '请先关闭所有 ELVION 进程，备份会话记录并人工核实后清理；不会自动删除或抢占。';
export async function diagnoseSessionLocks(home = getAppHome()): Promise<DiagnosticCheck[]> {
  const root = join(home, 'sessions'); let sessions: string[];
  try { sessions = await readdir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [{ name: '会话锁', state: '未验证', details: '尚无会话目录：' + root }];
    return [{ name: '会话锁', state: '失败', details: '无法读取会话目录：' + root }];
  }
  const checks: DiagnosticCheck[] = [];
  for (const id of sessions.filter(id => /^[a-f0-9-]{36}$/.test(id))) {
    const directory = join(root, id);
    try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) continue; } catch { continue; }
    const guard = join(directory, 'lock-claim');
    try { await lstat(guard); checks.push({ name: `会话 ${id} 锁获取标记`, state: '失败', details: `检测到锁获取标记：${guard}。可能仍有进程正在获取锁或上次崩溃残留。${manual}` }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') checks.push({ name: `会话 ${id} 锁获取标记`, state: '失败', details: `无法检查：${guard}。${manual}` }); }
    const lockPath = join(directory, 'lock.json');
    try {
      const info = await lstat(lockPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('格式无效');
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown; token?: unknown };
      if (!Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0 || typeof lock.token !== 'string' || !/^[a-f0-9-]{36}$/.test(lock.token)) throw new Error('格式无效');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') checks.push({ name: `会话 ${id} 锁文件`, state: '失败', details: `锁文件损坏或不可读取：${lockPath}。${manual}` });
    }
  }
  if (!checks.length) checks.push({ name: '会话锁', state: '通过', details: `未发现锁获取标记或损坏锁：${root}；不代表已验证全部会话记录。` });
  return checks;
}
