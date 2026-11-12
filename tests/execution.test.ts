import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { commandEnvironment, safeText } from '../execution/sanitize.js';
import { inspectBash, quoteBashArgument, runBash } from '../execution/bash.js';
import { createToolExecutor } from '../tools/index.js';
import type { ToolContext } from '../core/types.js';

describe('execution security primitives', () => {
  it('quotes metacharacters as a single literal Bash argument', () => { expect(quoteBashArgument("a'b; $(echo bad)")).toBe("'a'\"'\"'b; $(echo bad)'"); });
  it('does not propagate provider keys or shell injection environment', () => {
    const env = commandEnvironment({ PATH: 'safe', HOME: '/home', CUSTOM_KEY: 'the-provider-secret', OPENAI_API_KEY: 'abc', GITHUB_TOKEN: 'xyz', BASH_ENV: 'evil', NODE_OPTIONS: '--require evil' }, ['the-provider-secret']);
    expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined(); expect(env.CUSTOM_KEY).toBeUndefined(); expect(env.BASH_ENV).toBe(''); expect(env.PATH).toBe('safe');
  });
  it('removes ANSI, OSC clipboard control, C0/C1 and redacts literal secrets', () => { expect(safeText('a\x1b]52;c;evil\x07b\x1b[31mc\x1b[0m\0 secret', ['secret'])).toBe('abc [REDACTED]'); });
});

const bash = await inspectBash();
describe.skipIf(!bash.available)('actual bundled Bash lifecycle (requires prepared platform artifact)', () => {
  it('executes with Unicode/space cwd and does not run personal startup scripts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'elvion 中文 '));
    try { const result = await runBash({ command: "printf '你好'; printf '%s' \"$BASH_VERSION\"", cwd: dir, signal: new AbortController().signal }); expect(result.exitCode).toBe(0); expect(result.stdout).toMatch(/你好[0-9]+\./); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('supports literal quote handling and output limits', async () => {
    const value = "hello ' $(echo injected)"; const result = await runBash({ command: `printf '%s' ${quoteBashArgument(value)}`, cwd: process.cwd(), signal: new AbortController().signal }); expect(result.stdout).toBe(value);
    const long = await runBash({ command: "printf '%3000s' x", cwd: process.cwd(), maxOutputBytes: 1024, signal: new AbortController().signal }); expect(long.truncated).toBe(true); expect(Buffer.byteLength(long.stdout)).toBeLessThanOrEqual(1024);
  });
  it('executes Bash and Git tool wrappers through the same approved launcher', async () => {
    const executor = createToolExecutor(); let approvals = 0;
    const context: ToolContext = { cwd: process.cwd(), workspace: process.cwd(), permission: 'edit', signal: new AbortController().signal, approve: async () => { approvals++; return true; }, ask: async () => null, onOutput: () => undefined, setTodos: () => undefined, secrets: [], sessionDir: os.tmpdir() };
    const git = await executor.execute({ id: 'git-version', name: 'git', arguments: { args: ['--version'] } }, context);
    expect(git.isError).toBe(false); expect(git.content).toContain(process.platform === 'win32' ? 'git version 2.56.1.windows.1' : 'git version');
    const command = await executor.execute({ id: 'bash-pwd', name: 'bash', arguments: { command: 'printf approved' } }, context); expect(command.content).toContain('approved'); expect(approvals).toBe(2);
  });
  it('cancels ordinary background descendants and leaves no delayed side effect', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'elvion-cancel-')); const controller = new AbortController();
    try {
      const pending = runBash({ command: '(sleep 2; printf bad > leftover) & wait', cwd: dir, signal: controller.signal }); setTimeout(() => controller.abort(), 250);
      const result = await pending; expect(result.cancelled).toBe(true); await new Promise(resolve => setTimeout(resolve, 2200)); await expect(readFile(path.join(dir, 'leftover'))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('enforces timeout rather than reporting success', async () => { const result = await runBash({ command: 'sleep 10', cwd: process.cwd(), timeoutMs: 100, signal: new AbortController().signal }); expect(result.timedOut).toBe(true); expect(result.exitCode).not.toBe(0); });
  it.skipIf(process.platform !== 'win32')('cleans ordinary descendants when the owning CLI is forcibly killed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'elvion-crash-'));
    const script = `import {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(bash.launcher)}, ['--bash',${JSON.stringify(bash.path)},'--cwd',${JSON.stringify(dir)},'--command', 'printf ready > ready; (sleep 2; printf bad > leftover) & wait'],{stdio:['pipe','ignore','ignore'],windowsHide:true}); child.on('error',()=>process.exit(2)); setInterval(()=>{},1000);`;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', windowsHide: true });
    try {
      let ready = false; for (let i = 0; i < 60; i++) { if (await readFile(path.join(dir, 'ready')).then(() => true).catch(() => false)) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 50)); }
      expect(ready).toBe(true); owner.kill('SIGKILL'); await new Promise(resolve => owner.once('close', resolve));
      await new Promise(resolve => setTimeout(resolve, 2200)); await expect(readFile(path.join(dir, 'leftover'))).rejects.toThrow();
    } finally { owner.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
  });
});
