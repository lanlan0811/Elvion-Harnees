import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ElvionError } from '@elvion/kernel';
import { WINDOWS_JOB_READY, quoteWindowsArgument, windowsJobScript } from './windows-job.js';

export interface ProcessOptions { cwd: string; signal: AbortSignal; timeoutMs: number; maxOutputChars: number; superviseTree?: boolean; readyMarker?: string }
export interface ProcessResult { stdout: string; stderr: string; exitCode: number; truncated: boolean }
async function windowsExecutable(executable: string): Promise<string> {
  if (isAbsolute(executable)) return executable;
  for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of ['', '.exe']) {
      const candidate = join(directory, executable + extension);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue explicit PATH search. */ }
    }
  }
  throw new ElvionError('configuration_error', 'Required executable was not found on PATH');
}

export async function findGitBash(explicitPath?: string): Promise<string> {
  const candidates = explicitPath === undefined
    ? process.platform === 'win32'
      ? [process.env['ELVION_BASH_PATH'], 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs/Git/bin/bash.exe') : undefined]
      : ['/bin/bash', '/usr/bin/bash']
    : [explicitPath];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Probe the next known install path. */ }
  }
  if (explicitPath === undefined && process.platform === 'win32') {
    for (const entry of (process.env['PATH'] ?? '').split(delimiter)) {
      const candidate = join(entry, '../bin/bash.exe');
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue diagnostic probing. */ }
    }
  }
  throw new ElvionError('configuration_error', 'Git Bash was not found. Install Git for Windows or set ELVION_BASH_PATH to its bash.exe');
}

/** Spawn without a shell; caller owns authorization. Cancellation waits for process-tree termination. */
export async function runProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal.aborted) throw new ElvionError('cancelled', 'Process was cancelled before starting');
  if (process.platform === 'win32' && options.superviseTree !== false) executable = await windowsExecutable(executable);
  return await new Promise<ProcessResult>((resolve, reject) => {
    const supervised = process.platform === 'win32' && options.superviseTree !== false;
    const config = Buffer.from(JSON.stringify({ executable, commandLine: [executable, ...args].map(quoteWindowsArgument).join(' '), cwd: options.cwd }), 'utf8').toString('base64');
    const child = spawn(supervised ? join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : executable, supervised ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsJobScript, 'utf16le').toString('base64')] : [...args], { cwd: options.cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...(supervised ? { ELVION_PROCESS_CONFIG: config } : {}) } });
    let stdout = ''; let stderr = ''; let truncated = false; let stopReason: 'cancelled' | 'timeout' | undefined;
    let killing: Promise<void> | undefined;
    const outDecoder = new StringDecoder('utf8'); const errDecoder = new StringDecoder('utf8');
    const readiness = [...(supervised ? [WINDOWS_JOB_READY] : []), ...(options.readyMarker ? [options.readyMarker] : [])];
    let timer: ReturnType<typeof setTimeout>; let errorPrefix = '';
    const append = (part: string, stream: 'stdout' | 'stderr'): void => {
      const used = stdout.length + stderr.length;
      const remaining = Math.max(0, options.maxOutputChars - used);
      if (part.length > remaining) truncated = true;
      if (stream === 'stdout') stdout += part.slice(0, remaining); else stderr += part.slice(0, remaining);
    };
    child.stdout.on('data', (chunk: Buffer) => append(outDecoder.write(chunk), 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => {
      const value = errDecoder.write(chunk);
      if (!readiness.length) { append(value, 'stderr'); return; }
      errorPrefix += value;
      while (readiness[0] && errorPrefix.includes(readiness[0])) {
        const marker = readiness.shift()!; const index = errorPrefix.indexOf(marker);
        append(errorPrefix.slice(0, index), 'stderr'); errorPrefix = errorPrefix.slice(index + marker.length);
      }
      if (!readiness.length) {
        append(errorPrefix, 'stderr'); errorPrefix = '';
        clearTimeout(timer); timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
      }
    });
    const terminate = (reason: 'cancelled' | 'timeout'): void => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      killing = new Promise<void>(done => {
        if (child.pid === undefined) { done(); return; }
        if (supervised) { child.kill('SIGKILL'); done(); }
        else if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          killer.once('error', () => { child.kill('SIGKILL'); done(); });
          killer.once('close', () => done());
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          done();
        }
      });
    };
    const onAbort = (): void => terminate('cancelled');
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    timer = setTimeout(() => terminate('timeout'), readiness.length ? 30_000 : options.timeoutMs);
    const cleanup = (): void => { clearTimeout(timer); options.signal.removeEventListener('abort', onAbort); };
    child.once('error', error => { cleanup(); reject(new ElvionError('tool_error', 'Executable could not be started', { cause: error })); });
    child.once('close', (code) => {
      cleanup();
      append(outDecoder.end(), 'stdout'); append(errorPrefix + errDecoder.end(), 'stderr');
      void (async () => {
        if (killing) await killing;
        if (stopReason) throw new ElvionError(stopReason, stopReason === 'timeout' ? 'Process exceeded its timeout; its local process tree was terminated' : 'Process was cancelled; its local process tree was terminated');
        if (code === null) throw new ElvionError('tool_error', 'Process ended without an exit code');
        resolve({ stdout, stderr, exitCode: code, truncated });
      })().catch(reject);
    });
  });
}
