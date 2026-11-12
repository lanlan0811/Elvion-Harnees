import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandEnvironment, safeText } from './sanitize.js';

const require = createRequire(import.meta.url);
export interface BashInspection { available: boolean; path?: string; launcher?: string; error?: string }
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
export async function inspectBash(): Promise<BashInspection> {
  if (process.platform === 'darwin') return await exists('/bin/bash') ? { available: true, path: '/bin/bash' } : { available: false, error: '未找到 macOS /bin/bash。' };
  if (process.platform !== 'win32') return { available: false, error: '首版仅支持 Windows 和 macOS。' };
  if (!['x64', 'arm64'].includes(process.arch)) return { available: false, error: `不支持的 Windows 架构：${process.arch}` };
  const packageName = `elvion-harnees-win32-${process.arch}`;
  const roots: string[] = [];
  try { roots.push(path.dirname(require.resolve(`${packageName}/package.json`))); } catch { /* Optional dependency can be absent. */ }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Explicit checkout development runtime only; never use PATH or a machine Bash.
  roots.push(path.resolve(here, '..', 'packages', `platform-win32-${process.arch}`));
  roots.push(path.resolve(here, '..', '..', 'packages', `platform-win32-${process.arch}`));
  for (const root of roots) {
    const bash = path.join(root, 'runtime', 'bin', 'bash.exe');
    const launcher = path.join(root, 'bin', 'elvion-job.exe');
    if (await exists(bash) && await exists(launcher)) return { available: true, path: await realpath(bash), launcher: await realpath(launcher) };
  }
  return { available: false, error: `缺少完整 Bash 平台包 ${packageName}（含进程启动器）。请重新安装并包含 optional dependencies；开发环境先运行 npm run prepare:platform。` };
}

export interface BashOptions { command: string; cwd: string; signal: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; secrets?: string[]; onOutput?: (text: string) => void }
export interface BashResult { stdout: string; stderr: string; exitCode: number; cancelled: boolean; timedOut: boolean; truncated: boolean; durationMs: number }
export async function runBash(options: BashOptions): Promise<BashResult> {
  const inspection = await inspectBash();
  if (!inspection.available || !inspection.path) throw new Error(inspection.error);
  options.signal.throwIfAborted();
  const cwd = await realpath(options.cwd);
  const windows = process.platform === 'win32';
  const executable = windows ? inspection.launcher! : process.execPath;
  const supervisor = fileURLToPath(new URL('./supervisor.js', import.meta.url));
  const supervisorPath = await exists(supervisor) ? supervisor : fileURLToPath(new URL('../dist/execution/supervisor.js', import.meta.url));
  const args = windows
    ? ['--bash', inspection.path, '--cwd', cwd, '--command', options.command]
    : [supervisorPath, inspection.path, cwd, options.command];
  const started = Date.now();
  const env = commandEnvironment(process.env, options.secrets);
  if (windows) {
    const runtime = path.dirname(path.dirname(inspection.path));
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = [path.join(runtime, 'usr', 'bin'), path.join(runtime, 'mingw64', 'bin'), path.join(runtime, 'cmd'), env[pathKey] ?? ''].join(path.delimiter);
  }
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] });
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  let bytes = 0, stdout = '', stderr = '', cancelled = false, timedOut = false, truncated = false;
  const secrets = options.secrets ?? [];
  const streams = new Map<string, string>([['stdout', ''], ['stderr', '']]);
  const receive = (kind: 'stdout' | 'stderr', chunk: string) => {
    const allowed = Math.max(0, limit - bytes);
    const buffer = Buffer.from(chunk, 'utf8'); bytes += buffer.length;
    if (buffer.length > allowed) truncated = true;
    const text = buffer.subarray(0, allowed).toString('utf8').replace(/\uFFFD$/u, '');
    if (kind === 'stdout') stdout += text; else stderr += text;
    // Complete lines only: secrets and terminal sequences may cross IO chunks.
    const pending = (streams.get(kind) ?? '') + text;
    const end = pending.lastIndexOf('\n');
    if (end >= 0) { options.onOutput?.(safeText(pending.slice(0, end + 1), secrets)); streams.set(kind, pending.slice(end + 1)); }
    else streams.set(kind, pending);
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => receive('stdout', String(chunk)));
  child.stderr.on('data', chunk => receive('stderr', String(chunk)));
  child.stdin.on('error', () => { /* The command can finish before a cancel. */ });
  const stop = () => { child.stdin.end(); };
  const abort = () => { cancelled = true; stop(); };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120000);
  try {
    const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 130)); });
    for (const pending of streams.values()) if (pending) options.onOutput?.(safeText(pending, secrets));
    return { stdout: safeText(stdout, secrets), stderr: safeText(stderr, secrets), exitCode: code, cancelled, timedOut, truncated, durationMs: Date.now() - started };
  } finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); child.stdin.destroy(); }
}

export function quoteBashArgument(value: string): string { return String.fromCharCode(39) + value.split(String.fromCharCode(39)).join(String.fromCharCode(39, 34, 39, 34, 39)) + String.fromCharCode(39); }
