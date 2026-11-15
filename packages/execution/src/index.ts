import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent, createSensitiveRedactor } from '@elvion/agent';
import { captureVerificationBaseline, verifyProject, type VerificationBaseline } from '@elvion/verification';
import { recoveryDecision } from '@elvion/recovery';
import { TaskGraph, planTask, validateTaskPlan } from '@elvion/task';
import { SessionRepository, SessionSnapshotSchema, defaultDataDirectory, type SessionSnapshot } from '@elvion/session';
import { ToolRuntime } from '@elvion/tool';
import { BudgetTracker, CancellationScope, ElvionError, EventSequencer, serializeError, type ApprovalHandler, type EventEnvelope, type JsonValue, type ModelRuntime, type PermissionMode, type BudgetLimits } from '@elvion/kernel';

export interface ExecutionOptions {
  task: string; workspace: string; providerId: string; model: string; runtime: ModelRuntime;
  repository: SessionRepository; permissions?: PermissionMode; signal?: AbortSignal;
  approve?: ApprovalHandler; budget?: Partial<BudgetLimits>; session?: SessionSnapshot;
  tools?: ToolRuntime; lockDirectory?: string;
  plan?: unknown;
}
async function acquireWorkspace(workspace: string, directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex');
  const file = join(directory, `${key}.lock`);
  const token = randomUUID();
  try {
    const handle = await open(file, 'wx');
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
  } catch (cause) {
    throw new ElvionError('conflict', 'Workspace is locked by another execution. A stale lock requires explicit inspection before removal.', { cause });
  }
  return async () => {
    const current: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof current === 'object' && current !== null && 'token' in current && current.token === token) await rm(file);
  };
}

function hasUncertainToolCalls(events: readonly EventEnvelope[]): boolean {
  const pending = new Set<string>();
  for (const event of events) {
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) continue;
    if (event.type === 'tool.started' && typeof event.payload['id'] === 'string') pending.add(event.payload['id']);
    if (event.type === 'tool.finished' && typeof event.payload['toolCallId'] === 'string') pending.delete(event.payload['toolCallId']);
  }
  return pending.size > 0;
}

/** One serial execution owns workspace mutation and persists intent before each side effect. */
export async function* executeTask(options: ExecutionOptions): AsyncIterable<EventEnvelope> {
  const workspace = await realpath(options.workspace);
  const budget = new BudgetTracker(options.budget);
  const explicitPlan = options.plan === undefined ? undefined : validateTaskPlan(options.plan);
  const now = new Date().toISOString();
  const snapshot: SessionSnapshot = options.session ? SessionSnapshotSchema.parse(options.session) : { schemaVersion: 1, id: randomUUID(), workspace, providerId: options.providerId, permissions: options.permissions ?? 'auto-edit', state: 'created', task: options.task, messages: [], lastSequence: 0, createdAt: now, updatedAt: now };
  if (options.permissions) snapshot.permissions = options.permissions;
  SessionSnapshotSchema.parse(snapshot);
  if (options.session) {
    let savedWorkspace: string;
    try { savedWorkspace = await realpath(snapshot.workspace); }
    catch (cause) { throw new ElvionError('configuration_error', 'Saved workspace is unavailable', { cause }); }
    // Resolve directory aliases for comparison; retain the saved identity for persistence.
    if (savedWorkspace !== workspace || snapshot.providerId !== options.providerId) throw new ElvionError('configuration_error', 'Resume must use the saved workspace and provider');
  }
  const sequence = new EventSequencer({ sessionId: snapshot.id, executionId: randomUUID(), nextSequence: snapshot.lastSequence + 1 });
  const redact = createSensitiveRedactor();
  const cancellation = new CancellationScope({ ...(options.signal ? { signal: options.signal } : {}), timeoutMs: budget.limits.maxDurationMs });
  let release: () => Promise<void>;
  try { release = await acquireWorkspace(workspace, options.lockDirectory ?? join(defaultDataDirectory(), 'locks')); }
  catch (error) { cancellation.dispose(); throw error; }
  let persistenceFailed = false;
  const saveEvent = async (type: string, payload: JsonValue): Promise<EventEnvelope> => {
    const event = sequence.next(type, redact.value(payload));
    const saved = redact.value({ ...snapshot, lastSequence: event.sequence, updatedAt: event.timestamp });
    // Keep identity/correlation unchanged; only free-form messages/task are sensitive text.
    saved.id = snapshot.id; saved.workspace = snapshot.workspace; saved.providerId = snapshot.providerId;
    try { await options.repository.save(saved, [event]); }
    catch (cause) { persistenceFailed = true; throw new ElvionError('storage_error', 'Cannot persist execution progress', { cause }); }
    snapshot.lastSequence = event.sequence; snapshot.updatedAt = event.timestamp;
    return event;
  };
  try {
    const tools = options.tools ?? new ToolRuntime();
    const uncertain = options.session ? hasUncertainToolCalls(await options.repository.events(snapshot.id)) : false;
    if (options.session && (uncertain || ['running','awaiting_approval','verifying','recovering','needs_review'].includes(options.session.state))) {
      snapshot.state = 'needs_review';
      yield await saveEvent('execution.needs_review', { reason: 'Previous execution stopped with potentially unknown side effects. Inspect actual files, Git status and processes before starting a new task; automatic replay is disabled.' });
      return;
    }
    snapshot.task = options.task;
    snapshot.messages.push({ role: 'user', content: options.task });
    snapshot.state = 'running';
    yield await saveEvent('execution.started', { workspace, permissions: snapshot.permissions, task: options.task });
    let verificationBaseline: VerificationBaseline | undefined;
    const baselineEvents: EventEnvelope[] = [];
    let baselineFailure: unknown;
    try { verificationBaseline = await captureVerificationBaseline({
      tools, context: { workspace, permissionMode: snapshot.permissions, signal: cancellation.signal, ...(options.approve ? { approve: async (request, approvalOptions) => options.approve!(redact.value(request), approvalOptions) } : {}) }, budget,
      onToolStarted: async call => { baselineEvents.push(await saveEvent('tool.started', { ...call, source: 'verification-baseline' })); },
      onToolFinished: async result => { baselineEvents.push(await saveEvent('tool.finished', { ...result, source: 'verification-baseline' } as unknown as JsonValue)); },
    }); } catch (error) { baselineFailure = error; }
    for (const event of baselineEvents) yield event;
    if (baselineFailure) throw baselineFailure;
    yield await saveEvent('verification.baseline', { manager: verificationBaseline?.manager ?? null, scriptNames: Object.keys(verificationBaseline?.scripts ?? {}) });
    yield await saveEvent('task.planning', { source: explicitPlan ? 'explicit' : 'model' });
    const planned = explicitPlan ?? await planTask({ runtime: options.runtime, model: options.model, goal: redact.text(options.task), signal: cancellation.signal, budget });
    const graph = new TaskGraph(planned);
    yield await saveEvent('task.planned', { tasks: graph.snapshot() as unknown as JsonValue });
    let repairs = 0; let retries = 0;
    let currentTask = graph.next();
    if (!currentTask) throw new ElvionError('invalid_state', 'Task plan contains no runnable work');
    graph.transition(currentTask.id, 'running');
    snapshot.messages.push({ role: 'user', content: JSON.stringify({ taskId: currentTask.id, title: currentTask.title, acceptance: currentTask.acceptance, overallGoal: options.task }) });
    yield await saveEvent('task.started', { task: currentTask as unknown as JsonValue });
    while (true) {
      let observed = false;
      try {
        for await (const event of runAgent({ runtime: options.runtime, model: options.model, tools, workspace, permissionMode: snapshot.permissions, signal: cancellation.signal, budget, goal: `${options.task} Current task: ${currentTask.title}. Acceptance: ${currentTask.acceptance.join('; ')}`, messages: snapshot.messages, ...(options.approve ? { approve: options.approve } : {}) })) {
          if (event.type !== 'agent.turn') observed = true;
          yield await saveEvent(event.type, event.payload);
        }
      } catch (error) {
        if (!observed && recoveryDecision(error, { retries, repairs }) === 'retry') {
          budget.consumeRetry(); retries++; yield await saveEvent('execution.retry', { attempt: retries, error: serializeError(error) as unknown as JsonValue }); continue;
        }
        throw error;
      }
      snapshot.state = 'verifying';
      yield await saveEvent('verification.started', { taskId: currentTask.id });
      const verificationEvents: EventEnvelope[] = [];
      let verificationFailure: unknown;
      let report;
      try { report = await verifyProject({
        tools, context: { workspace, permissionMode: snapshot.permissions, signal: cancellation.signal, ...(options.approve ? { approve: async (request, approvalOptions) => options.approve!(redact.value(request), approvalOptions) } : {}) },
        timeoutMs: budget.limits.toolTimeoutMs, budget,
        ...(verificationBaseline ? { baseline: verificationBaseline } : {}),
        onBaselineCaptured: baseline => { verificationBaseline = baseline; },
        onToolStarted: async call => { verificationEvents.push(await saveEvent('tool.started', { ...call, source: 'verification' })); },
        onToolFinished: async result => { verificationEvents.push(await saveEvent('tool.finished', { ...result, source: 'verification' } as unknown as JsonValue)); },
      }); } catch (error) { verificationFailure = error; }
      for (const event of verificationEvents) yield event;
      if (verificationFailure) throw verificationFailure;
      if (!report) throw new ElvionError('verification_failed', 'Verification returned no report');
      yield await saveEvent('verification.finished', report as unknown as JsonValue);
      if (report.passed) {
        graph.transition(currentTask.id, 'completed', { verified: true });
        yield await saveEvent('task.completed', { taskId: currentTask.id, tasks: graph.snapshot() as unknown as JsonValue });
        const nextTask = graph.next();
        if (nextTask) {
          currentTask = nextTask; graph.transition(currentTask.id, 'running'); snapshot.state = 'running';
          snapshot.messages.push({ role: 'user', content: JSON.stringify({ taskId: currentTask.id, title: currentTask.title, acceptance: currentTask.acceptance, overallGoal: options.task }) });
          yield await saveEvent('task.started', { task: currentTask as unknown as JsonValue });
          continue;
        }
        if (graph.snapshot().some(task => task.status !== 'completed')) throw new ElvionError('invalid_state', 'Task graph could not complete all dependencies');
        snapshot.state = 'completed';
        yield await saveEvent('execution.completed', { report: report as unknown as JsonValue, tasks: graph.snapshot() as unknown as JsonValue, budget: budget.snapshot() as unknown as JsonValue }); return;
      }
      const failure = new ElvionError('verification_failed', 'Independent verification failed');
      if (report.checks.some(check => check.status === 'not_run') || recoveryDecision(failure, { retries, repairs }) !== 'repair') throw failure;
      budget.consumeRepair(); repairs++; snapshot.state = 'recovering';
      snapshot.messages.push({ role: 'user', content: `Independent verification failed. Repair using this objective evidence, preserve prior changes and rerun appropriate checks: ${JSON.stringify(report)}` });
      yield await saveEvent('execution.repair', { round: repairs }); snapshot.state = 'running';
    }
  } catch (error) {
    if (persistenceFailed) throw error;
    const normalized = cancellation.signal.aborted ? cancellation.signal.reason as unknown : error;
    const failure = serializeError(normalized);
    snapshot.state = failure.details?.['requiresReview'] === true ? 'needs_review' : failure.code === 'cancelled' ? 'cancelled' : failure.code === 'timeout' ? 'timed_out' : failure.code === 'approval_required' ? 'approval_required' : 'failed';
    yield await saveEvent(`execution.${snapshot.state}`, { error: failure as unknown as JsonValue, budget: budget.snapshot() as unknown as JsonValue });
  } finally { cancellation.dispose(); await release(); }
}
