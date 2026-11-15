import { z } from 'zod';
import { JsonObjectSchema, type JsonObject } from './json.js';

export const ErrorCodeSchema = z.enum([
  'validation_error',
  'configuration_error',
  'permission_denied',
  'approval_required',
  'cancelled',
  'timeout',
  'budget_exceeded',
  'model_error',
  'tool_error',
  'storage_error',
  'invalid_state',
  'conflict',
  'not_found',
  'verification_failed',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SerializedErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: JsonObjectSchema.optional(),
});
export type SerializedError = z.infer<typeof SerializedErrorSchema>;

export interface ElvionErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  /** Only non-sensitive structured information may cross an event boundary. */
  details?: JsonObject;
}

export class ElvionError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(code: ErrorCode, message: string, options: ElvionErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ElvionError';
    this.code = ErrorCodeSchema.parse(code);
    this.retryable =
      !['cancelled', 'permission_denied', 'approval_required'].includes(code) &&
      (options.retryable ?? false);
    this.details = options.details === undefined ? undefined : JsonObjectSchema.parse(options.details);
  }
}

/** Unknown exceptions keep their cause locally and expose no raw provider/process output. */
export function toElvionError(error: unknown, fallback: ErrorCode = 'internal_error'): ElvionError {
  if (error instanceof ElvionError) return error;
  return new ElvionError(fallback, 'An unexpected operation failure occurred', { cause: error });
}

/** Stack traces and cause chains are intentionally not serialized. */
export function serializeError(error: unknown): SerializedError {
  const normalized = toElvionError(error);
  return SerializedErrorSchema.parse({
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.details === undefined ? {} : { details: normalized.details }),
  });
}
