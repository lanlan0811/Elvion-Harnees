import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalDecisionSchema,
  BudgetLimitsSchema,
  BudgetTracker,
  CancellationScope,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_PERMISSION_MODE,
  ElvionError,
  EventEnvelopeSchema,
  EventSequencer,
  ExecutionRequestSchema,
  JsonValueSchema,
  ModelEventSchema,
  ModelMessageSchema,
  PermissionModeSchema,
  raceWithSignal,
  serializeError,
  throwIfAborted,
  ToolCallSchema,
  ToolResultSchema,
  validateEventSequence,
} from '../src/index.js';

describe('errors and untrusted input', () => {
  it('preserves a local cause and omits it from transport', () => {
    const cause = new Error('credential must stay local');
    const error = new ElvionError('tool_error', 'The tool failed', { cause, details: { tool: 'read_file' } });
    expect(error.cause).toBe(cause);
    expect(serializeError(error)).toEqual({
      code: 'tool_error', message: 'The tool failed', retryable: false, details: { tool: 'read_file' },
    });
    expect(JSON.stringify(serializeError(cause))).not.toContain('credential');
  });

  it.each(['cancelled', 'permission_denied', 'approval_required'] as const)('never makes %s retryable', (code) => {
    expect(new ElvionError(code, 'Stopped', { retryable: true }).retryable).toBe(false);
  });

  it('rejects non-JSON values and incomplete tool arguments', () => {
    expect(JsonValueSchema.safeParse({ value: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(JsonValueSchema.safeParse({ value: undefined }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ id: 'a', name: 'bash', arguments: '{' }).success).toBe(false);
    expect(ToolCallSchema.parse({ id: 'a', name: 'read_file', arguments: { path: '中文.ts' } }).arguments).toEqual({ path: '中文.ts' });
  });

  it('requires tool results to retain correlation and structured errors', () => {
    expect(ToolResultSchema.safeParse({ status: 'success', output: 'ok', durationMs: 1 }).success).toBe(false);
    expect(ToolResultSchema.parse({ status: 'success', toolCallId: 'a', output: 'ok', durationMs: 1 }).truncated).toBe(false);
    expect(ToolResultSchema.safeParse({ status: 'error', toolCallId: 'a', error: 'failed', durationMs: 1 }).success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse({ decision: 'approved' }).success).toBe(false);
  });

  it('requires tool messages and assistant calls to be correctly correlated', () => {
    expect(ModelMessageSchema.safeParse({ role: 'tool', content: 'result' }).success).toBe(false);
    expect(ModelMessageSchema.safeParse({ role: 'user', content: 'hi', toolCallId: 'a' }).success).toBe(false);
    expect(ModelMessageSchema.safeParse({ role: 'user', content: 'hi', toolCalls: [] }).success).toBe(false);
    expect(ModelMessageSchema.parse({ role: 'tool', content: 'result', toolCallId: 'a' }).toolCallId).toBe('a');
  });

  it('represents absent usage as unknown and rejects malformed model events', () => {
    expect(ModelEventSchema.parse({ type: 'usage', usage: { inputTokens: null, outputTokens: null, totalTokens: null } })).toEqual({
      type: 'usage', usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });
    expect(ModelEventSchema.safeParse({ type: 'tool_call', call: { id: 'x', name: 'read_file', arguments: [] } }).success).toBe(false);
    expect(ModelEventSchema.safeParse({ type: 'usage', usage: { inputTokens: -1 } }).success).toBe(false);
  });

  it('uses auto-edit by default and rejects unknown or escalated permission values', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto-edit');
    expect(PermissionModeSchema.safeParse('admin').success).toBe(false);
    expect(ExecutionRequestSchema.parse({ sessionId: 's', executionId: 'e', task: 'Read', workspace: 'D:/repo' }).permissions).toBe('auto-edit');
  });
});

describe('cancellation and deadlines', () => {
  it('propagates an already-cancelled parent without exposing its reason', () => {
    const parent = new AbortController();
    parent.abort(new Error('private reason'));
    const scope = new CancellationScope({ signal: parent.signal, timeoutMs: 100 });
    expect(scope.signal.aborted).toBe(true);
    expect(() => throwIfAborted(scope.signal)).toThrowError('Operation cancelled');
    scope.dispose();
  });

  it('cancels pending waits and leaves the parent untouched', async () => {
    const parent = new AbortController();
    const scope = new CancellationScope({ signal: parent.signal });
    const pending = raceWithSignal(new Promise<never>(() => undefined), scope.signal);
    scope.cancel();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(parent.signal.aborted).toBe(false);
  });

  it('cancels promptly when a parent aborts later', async () => {
    const parent = new AbortController();
    const scope = new CancellationScope({ signal: parent.signal });
    const pending = raceWithSignal(new Promise<never>(() => undefined), scope.signal);
    parent.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    scope.dispose();
  });

  it('distinguishes timeouts from user cancellation and releases its timer', async () => {
    vi.useFakeTimers();
    try {
      const scope = new CancellationScope({ timeoutMs: 20 });
      const pending = raceWithSignal(new Promise<never>(() => undefined), scope.signal);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes resources without cancelling completed work', async () => {
    vi.useFakeTimers();
    try {
      const scope = new CancellationScope({ timeoutMs: 20 });
      await expect(raceWithSignal(Promise.resolve('done'), scope.signal)).resolves.toBe('done');
      scope.dispose();
      await vi.advanceTimersByTimeAsync(30);
      expect(scope.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() => new CancellationScope({ timeoutMs })).toThrowError(ElvionError);
  });
});

describe('bounded execution budgets', () => {
  it('matches the planned default ceilings', () => {
    expect(DEFAULT_BUDGET_LIMITS).toEqual({ maxTurns: 50, maxToolCalls: 100, maxDurationMs: 1_800_000, maxRetries: 2, maxRepairs: 2, toolTimeoutMs: 120_000 });
    expect(BudgetLimitsSchema.safeParse({ maxTurns: 0 }).success).toBe(false);
    expect(Object.isFrozen(DEFAULT_BUDGET_LIMITS)).toBe(true);
  });

  it('enforces all caps before consuming an extra attempt', () => {
    const budget = new BudgetTracker({ maxTurns: 1, maxToolCalls: 1, maxRetries: 1, maxRepairs: 1 });
    budget.consumeTurn();
    budget.consumeToolCall();
    budget.consumeRetry();
    budget.consumeRepair();
    for (const consume of [() => budget.consumeTurn(), () => budget.consumeToolCall(), () => budget.consumeRetry(), () => budget.consumeRepair()]) {
      expect(consume).toThrowError(ElvionError);
    }
    expect(budget.snapshot()).toMatchObject({ turns: 1, toolCalls: 1, retries: 1, repairs: 1 });
  });

  it('honors zero retries and repairs and the exact deadline', () => {
    let now = 100;
    const budget = new BudgetTracker({ maxRetries: 0, maxRepairs: 0, maxDurationMs: 50 }, { now: () => now });
    expect(() => budget.consumeRetry()).toThrowError(/budget exhausted/);
    expect(() => budget.consumeRepair()).toThrowError(/budget exhausted/);
    now = 149;
    budget.consumeTurn();
    now = 150;
    expect(() => budget.consumeToolCall()).toThrowError(/duration budget exhausted/);
    expect(budget.snapshot()).toMatchObject({ turns: 1, toolCalls: 0, elapsedMs: 50, remainingMs: 0 });
  });
});

describe('versioned event history', () => {
  const now = () => new Date('2026-11-15T00:00:00.000Z');

  it('generates contiguous correlated events and resumes at the saved sequence', () => {
    const events = new EventSequencer({ sessionId: 's', executionId: 'e', now });
    const first = events.next('execution.started', { task: 'Read repository' });
    const second = events.next('model.text', { text: '中文' });
    expect(first).toMatchObject({ version: 1, sequence: 1, sessionId: 's', executionId: 'e', timestamp: now().toISOString() });
    expect(validateEventSequence([first, second], { sessionId: 's' })).toHaveLength(2);
    const restored = new EventSequencer({ sessionId: 's', nextSequence: 3, now });
    const third = restored.next('execution.finished', { state: 'completed' });
    expect(validateEventSequence([third], { sessionId: 's', previousSequence: 2 })[0]?.sequence).toBe(3);
  });

  it('rejects duplicate, missing, cross-session and unknown-version events', () => {
    const events = new EventSequencer({ sessionId: 's', now });
    const first = events.next('test.event', {});
    const second = events.next('test.event', {});
    expect(() => validateEventSequence([first, first], { sessionId: 's' })).toThrowError(ElvionError);
    expect(() => validateEventSequence([second], { sessionId: 's' })).toThrowError(ElvionError);
    expect(() => validateEventSequence([first], { sessionId: 'other' })).toThrowError(ElvionError);
    expect(EventEnvelopeSchema.safeParse({ ...first, version: 2 }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...first, timestamp: 'yesterday' }).success).toBe(false);
  });

  it('does not consume a sequence when invalid input is rejected', () => {
    const events = new EventSequencer({ sessionId: 's', now });
    expect(() => events.next('bad type', {})).toThrow();
    expect(events.next('valid.type', {}).sequence).toBe(1);
  });
});
