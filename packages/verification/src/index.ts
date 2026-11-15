import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolRuntime, type ToolContext } from '@elvion/tool';
import { ElvionError, throwIfAborted, type BudgetTracker, type ToolCall, type VerificationCheck, type VerificationReport, type ToolResult } from '@elvion/kernel';

const ManifestSchema = z.object({ scripts: z.record(z.string(), z.string()).optional(), packageManager: z.string().optional() });
const supportedChecks = ['lint','typecheck','type-check','check:types','test','test:unit','test:integration','test:e2e','build'] as const;
export interface VerificationBaseline {
  readonly manager: string;
  readonly packageManager: string | null;
  readonly scripts: Readonly<Record<string, string>>;
}
function successfulOutput(result: ToolResult): Record<string, unknown> {
  if (result.status !== 'success' || typeof result.output !== 'object' || result.output === null || Array.isArray(result.output)) return {};
  return result.output;
}
export interface VerificationOptions {
  tools: ToolRuntime; context: ToolContext; timeoutMs?: number; budget?: BudgetTracker;
  baseline?: VerificationBaseline;
  onBaselineCaptured?: (baseline: VerificationBaseline) => void;
  onToolStarted?: (call: ToolCall) => Promise<void>;
  onToolFinished?: (result: ToolResult) => Promise<void>;
}
function checkAuthorization(result: ToolResult, action: string): void {
  if (result.status === 'approval_required') throw new ElvionError('approval_required', `${action} requires approval`);
  if (result.status === 'denied') throw new ElvionError('permission_denied', `${action} was denied`);
  if (result.status === 'cancelled') throw new ElvionError('cancelled', `${action} was cancelled`);
}
async function executeCheckTool(options: VerificationOptions, call: ToolCall): Promise<ToolResult> {
  throwIfAborted(options.context.signal);
  options.budget?.consumeToolCall();
  await options.onToolStarted?.(call);
  const result = await options.tools.execute(call, options.context);
  await options.onToolFinished?.(result);
  throwIfAborted(options.context.signal);
  options.budget?.assertTimeRemaining();
  return result;
}
/** Read through Tool Runtime, including authorization, audit and the shared tool budget. */
export async function captureVerificationBaseline(options: VerificationOptions): Promise<VerificationBaseline | undefined> {
  const file = await executeCheckTool(options, { id: randomUUID(), name: 'read_file', arguments: { path: 'package.json' } });
  checkAuthorization(file, 'Project discovery');
  if (file.status !== 'success') {
    // read_file intentionally hides OS error details. Establish absence through a second authorized tool,
    // rather than treating unreadable, oversized or malformed existing manifests as a new project.
    const listed = await executeCheckTool(options, { id: randomUUID(), name: 'glob', arguments: { pattern: 'package.json', path: '.', maxResults: 1 } });
    checkAuthorization(listed, 'Project manifest discovery');
    const files = successfulOutput(listed)['files'];
    if (listed.status === 'success' && !listed.truncated && Array.isArray(files) && files.length === 0) return undefined;
    throw new ElvionError('verification_failed', 'Existing project manifest cannot be read for verification');
  }
  if (file.truncated) throw new ElvionError('verification_failed', 'Project manifest was truncated before verification');
  const output = successfulOutput(file);
  if (typeof output['content'] !== 'string') throw new ElvionError('verification_failed', 'Manifest read returned no content');
  let data: unknown;
  try { data = JSON.parse(output['content']); } catch { throw new ElvionError('verification_failed', 'Project package.json is invalid JSON'); }
  const manifest = ManifestSchema.safeParse(data);
  if (!manifest.success) throw new ElvionError('verification_failed', 'Project scripts are malformed');
  const manager = manifest.data.packageManager?.split('@')[0] ?? 'npm';
  if (!['npm','pnpm','yarn'].includes(manager)) throw new ElvionError('verification_failed', 'Unsupported project package manager');
  const scripts = manifest.data.scripts ?? {};
  return Object.freeze({ manager, packageManager: manifest.data.packageManager ?? null, scripts: Object.freeze({ ...scripts }) });
}
export function hasVerificationChecks(baseline: VerificationBaseline | undefined): baseline is VerificationBaseline {
  return baseline !== undefined && supportedChecks.some(name => Object.hasOwn(baseline.scripts, name));
}
function assertVerificationBaseline(current: VerificationBaseline | undefined, baseline: VerificationBaseline): void {
  const changedScripts = Object.entries(baseline.scripts).filter(([name, script]) => !current || current.scripts[name] !== script).map(([name]) => name);
  if (!current || current.manager !== baseline.manager || current.packageManager !== baseline.packageManager || changedScripts.length) {
    throw new ElvionError('verification_failed', 'Preexisting verification scripts or package manager changed; review is required before accepting new gates', {
      details: { requiresReview: true, changedScripts, packageManagerChanged: current?.packageManager !== baseline.packageManager },
    });
  }
}
/** Discover actual scripts and preserve the original gate definitions even after model edits. */
export async function discoverChecks(options: VerificationOptions): Promise<{ name: string; command: string[] }[]> {
  let current: VerificationBaseline | undefined;
  try { current = await captureVerificationBaseline(options); }
  catch (cause) {
    if (options.baseline && cause instanceof ElvionError && cause.code === 'verification_failed') {
      throw new ElvionError('verification_failed', 'The preexisting verification manifest became invalid or unreadable; review is required', { cause, details: { requiresReview: true } });
    }
    throw cause;
  }
  if (options.baseline) assertVerificationBaseline(current, options.baseline);
  if (!current) return [];
  options.onBaselineCaptured?.(current);
  return supportedChecks.filter(name => Object.hasOwn(current.scripts, name)).map(name => ({ name, command: [current.manager, 'run', name] }));
}
export async function verifyProject(options: VerificationOptions): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  const discovered = await discoverChecks(options);
  if (!discovered.length) return { passed: false, checks: [{ name: 'project-checks', command: [], exitCode: null, status: 'not_run', evidence: 'No supported project verification scripts discovered', failureReason: 'Explicit objective acceptance checks are required' }] };
  for (const check of discovered) {
    const remainingMs = options.budget?.snapshot().remainingMs;
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 120_000, remainingMs ?? 2_147_483_647));
    const result = await executeCheckTool(options, { id: randomUUID(), name: 'bash', arguments: { command: check.command.join(' '), timeoutMs } });
    if (result.status === 'approval_required') throw new ElvionError('approval_required', 'Verification command requires approval');
    if (result.status === 'denied') throw new ElvionError('permission_denied', 'Verification command was denied');
    if (result.status === 'cancelled') throw new ElvionError('cancelled', 'Verification command was cancelled');
    const output = successfulOutput(result);
    const exitCode = typeof output['exitCode'] === 'number' ? output['exitCode'] : null;
    const passed = result.status === 'success' && exitCode === 0;
    checks.push({ ...check, exitCode, status: passed ? 'passed' : result.status === 'error' && result.error.code === 'timeout' ? 'timed_out' : 'failed', evidence: JSON.stringify(result), ...(passed ? {} : { failureReason: result.status === 'error' ? result.error.message : 'Verification command did not exit successfully' }) });
  }
  return { passed: checks.every(check => check.status === 'passed'), checks };
}
