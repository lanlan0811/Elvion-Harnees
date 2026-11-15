import { z } from 'zod';
import { ElvionError } from './errors.js';
import { IdentifierSchema, JsonValueSchema, type JsonValue } from './json.js';

export const EVENT_VERSION = 1 as const;
export const EventEnvelopeSchema = z.strictObject({
  version: z.literal(EVENT_VERSION),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.iso.datetime(),
  sessionId: IdentifierSchema,
  executionId: IdentifierSchema.optional(),
  type: z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(128),
  payload: JsonValueSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Each session repository owns one sequence; restoring must use lastSequence + 1. */
export class EventSequencer {
  readonly #sessionId: string;
  readonly #executionId: string | undefined;
  readonly #now: () => Date;
  #nextSequence: number;

  constructor(options: {
    sessionId: string;
    executionId?: string;
    nextSequence?: number;
    now?: () => Date;
  }) {
    this.#sessionId = IdentifierSchema.parse(options.sessionId);
    this.#executionId = options.executionId === undefined ? undefined : IdentifierSchema.parse(options.executionId);
    this.#nextSequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(options.nextSequence ?? 1);
    this.#now = options.now ?? (() => new Date());
  }

  next<TType extends string, TPayload extends JsonValue>(
    type: TType,
    payload: TPayload,
  ): EventEnvelope & { type: TType; payload: TPayload } {
    if (!Number.isSafeInteger(this.#nextSequence)) {
      throw new ElvionError('invalid_state', 'Event sequence exhausted');
    }
    const event = EventEnvelopeSchema.parse({
      version: EVENT_VERSION,
      sequence: this.#nextSequence,
      timestamp: this.#now().toISOString(),
      sessionId: this.#sessionId,
      ...(this.#executionId === undefined ? {} : { executionId: this.#executionId }),
      type,
      payload,
    });
    this.#nextSequence += 1;
    return event as EventEnvelope & { type: TType; payload: TPayload };
  }
}

/** Reject replay gaps, duplicates and cross-session events before persistence or recovery. */
export function validateEventSequence(events: readonly unknown[], options: {
  sessionId: string;
  previousSequence?: number;
}): EventEnvelope[] {
  const sessionId = IdentifierSchema.parse(options.sessionId);
  let previous = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(options.previousSequence ?? 0);
  return events.map((value) => {
    const event = EventEnvelopeSchema.parse(value);
    if (event.sessionId !== sessionId || event.sequence !== previous + 1) {
      throw new ElvionError('invalid_state', 'Event history has an invalid session or sequence');
    }
    previous = event.sequence;
    return event;
  });
}
