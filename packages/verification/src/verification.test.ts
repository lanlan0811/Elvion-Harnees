import { describe, expect, it, vi } from 'vitest';
import { BudgetTracker } from '@elvion/kernel';
import { ToolRuntime } from '@elvion/tool';
import { captureVerificationBaseline, discoverChecks, verifyProject } from './index.js';
const context = { workspace: process.cwd(), permissionMode: 'full-access' as const, signal: new AbortController().signal };
describe('verification boundaries', () => {
  it('allows additional checks while preserving the existing scripts and manager', async () => {
    const tools = new ToolRuntime();
    let scripts = { test: 'node original-test.mjs' } as Record<string, string>;
    const execute = vi.spyOn(tools, 'execute').mockImplementation(async call => ({ toolCallId: call.id, status: 'success', durationMs: 0, truncated: false, output: { content: JSON.stringify({ packageManager: 'pnpm@11.25.0', scripts }) } }));
    const baseline = await captureVerificationBaseline({ tools, context });
    scripts = { ...scripts, build: 'tsc' };
    expect(await discoverChecks({ tools, context, baseline: baseline! })).toEqual([{ name: 'test', command: ['pnpm', 'run', 'test'] }, { name: 'build', command: ['pnpm', 'run', 'build'] }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('requires review for changed indirect helper scripts and package manager versions', async () => {
    const tools = new ToolRuntime();
    let manifest = { packageManager: 'pnpm@11.25.0', scripts: { test: 'pnpm run verify', verify: 'node original-test.mjs' } };
    vi.spyOn(tools, 'execute').mockImplementation(async call => ({ toolCallId: call.id, status: 'success', durationMs: 0, truncated: false, output: { content: JSON.stringify(manifest) } }));
    const baseline = await captureVerificationBaseline({ tools, context });
    manifest = { ...manifest, scripts: { ...manifest.scripts, verify: 'node -e process.exit(0)' } };
    await expect(discoverChecks({ tools, context, baseline: baseline! })).rejects.toMatchObject({ code: 'verification_failed', details: { requiresReview: true, changedScripts: ['verify'] } });
    manifest = { packageManager: 'pnpm@99.0.0', scripts: { ...baseline!.scripts } } as typeof manifest;
    await expect(discoverChecks({ tools, context, baseline: baseline! })).rejects.toMatchObject({ code: 'verification_failed', details: { requiresReview: true, packageManagerChanged: true } });
  });
  it('counts discovery and blocks additional commands when the budget is exhausted', async () => {
    const tools = new ToolRuntime();
    const execute = vi.spyOn(tools, 'execute').mockResolvedValue({ toolCallId: 'manifest', status: 'success', durationMs: 0, truncated: false, output: { content: JSON.stringify({ scripts: { test: 'node test.mjs' } }) } });
    const started = vi.fn(async () => undefined);
    const finished = vi.fn(async () => undefined);
    await expect(verifyProject({ tools, context, budget: new BudgetTracker({ maxToolCalls: 1 }), onToolStarted: started, onToolFinished: finished })).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });
  it('does not invoke a tool if persisting its intent fails', async () => {
    const tools = new ToolRuntime();
    const execute = vi.spyOn(tools, 'execute');
    await expect(verifyProject({ tools, context, onToolStarted: async () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps timeout evidence and stops before later verification commands', async () => {
    const tools = new ToolRuntime();
    const execute = vi.spyOn(tools, 'execute').mockImplementation(async call => {
      if (call.name === 'read_file') return { toolCallId: call.id, status: 'success', durationMs: 0, truncated: false, output: { content: JSON.stringify({ scripts: { lint: 'node lint.mjs', test: 'node test.mjs', build: 'node build.mjs' } }) } };
      if (call.arguments['command'] === 'npm run lint') return { toolCallId: call.id, status: 'success', durationMs: 1, truncated: false, output: { exitCode: 0 } };
      return { toolCallId: call.id, status: 'error', durationMs: 25, truncated: false, error: { code: 'timeout', message: 'Actual process timeout', retryable: false } };
    });
    const report = await verifyProject({ tools, context, timeoutMs: 25 });
    expect(report).toMatchObject({ passed: false, checks: [{ name: 'lint', exitCode: 0, status: 'passed' }, { name: 'test', exitCode: null, status: 'timed_out', failureReason: 'Actual process timeout' }] });
    expect(report.checks).toHaveLength(2);
    expect(JSON.parse(report.checks[1]!.evidence)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
    expect(execute.mock.calls.filter(([call]) => call.name === 'bash').map(([call]) => call.arguments['command'])).toEqual(['npm run lint', 'npm run test']);
  });
});
