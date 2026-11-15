import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { ElvionError } from './errors.js';

export const BudgetLimitsSchema = z.strictObject({
  maxTurns: z.number().int().positive().max(10_000).default(50),
  maxToolCalls: z.number().int().positive().max(100_000).default(100),
  maxDurationMs: z.number().int().positive().max(2_147_483_647).default(30 * 60_000),
  maxRetries: z.number().int().nonnegative().max(100).default(2),
  maxRepairs: z.number().int().nonnegative().max(100).default(2),
  toolTimeoutMs: z.number().int().positive().max(2_147_483_647).default(120_000),
});
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;
export const DEFAULT_BUDGET_LIMITS: Readonly<BudgetLimits> = Object.freeze(BudgetLimitsSchema.parse({}));
export const BudgetUsageSchema = z.strictObject({
  turns: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(), repairs: z.number().int().nonnegative(),
  elapsedMs: z.number().finite().nonnegative(),
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

export interface BudgetSnapshot {
  turns: number;
  toolCalls: number;
  retries: number;
  repairs: number;
  elapsedMs: number;
  remainingMs: number;
}

export class BudgetTracker {
  readonly limits: Readonly<BudgetLimits>;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #restoredElapsedMs: number;
  #turns = 0;
  #toolCalls = 0;
  #retries = 0;
  #repairs = 0;

  constructor(limits: Partial<BudgetLimits> = {}, options: { now?: () => number; restore?: BudgetUsage } = {}) {
    this.limits = Object.freeze(BudgetLimitsSchema.parse(limits));
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = this.#now();
    const restored = options.restore ? BudgetUsageSchema.parse(options.restore) : { turns: 0, toolCalls: 0, retries: 0, repairs: 0, elapsedMs: 0 };
    if (restored.turns > this.limits.maxTurns || restored.toolCalls > this.limits.maxToolCalls || restored.retries > this.limits.maxRetries || restored.repairs > this.limits.maxRepairs) throw new ElvionError('validation_error', 'Saved budget usage exceeds its limits');
    this.#turns = restored.turns; this.#toolCalls = restored.toolCalls; this.#retries = restored.retries; this.#repairs = restored.repairs;
    this.#restoredElapsedMs = restored.elapsedMs;
  }

  assertTimeRemaining(): void {
    if (this.#elapsed() >= this.limits.maxDurationMs) {
      throw new ElvionError('timeout', 'Execution duration budget exhausted');
    }
  }

  consumeTurn(): void {
    this.#consume('turns', this.#turns, this.limits.maxTurns);
    this.#turns += 1;
  }

  consumeToolCall(): void {
    this.#consume('toolCalls', this.#toolCalls, this.limits.maxToolCalls);
    this.#toolCalls += 1;
  }

  /** Aggregate safety cap; recovery must additionally enforce the per-operation retry cap. */
  consumeRetry(): void {
    this.#consume('retries', this.#retries, this.limits.maxRetries);
    this.#retries += 1;
  }

  consumeRepair(): void {
    this.#consume('repairs', this.#repairs, this.limits.maxRepairs);
    this.#repairs += 1;
  }

  snapshot(): BudgetSnapshot {
    const elapsedMs = this.#elapsed();
    return {
      turns: this.#turns,
      toolCalls: this.#toolCalls,
      retries: this.#retries,
      repairs: this.#repairs,
      elapsedMs,
      remainingMs: Math.max(0, this.limits.maxDurationMs - elapsedMs),
    };
  }

  usage(): BudgetUsage {
    return { turns: this.#turns, toolCalls: this.#toolCalls, retries: this.#retries, repairs: this.#repairs, elapsedMs: this.#elapsed() };
  }

  #elapsed(): number {
    return this.#restoredElapsedMs + Math.max(0, this.#now() - this.#startedAt);
  }

  #consume(resource: string, used: number, maximum: number): void {
    this.assertTimeRemaining();
    if (used >= maximum) {
      throw new ElvionError('budget_exceeded', `Execution ${resource} budget exhausted`, {
        details: { resource, used, maximum },
      });
    }
  }
}
