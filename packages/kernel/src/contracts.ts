import { z } from 'zod';
import { BudgetLimitsSchema } from './budget.js';
import { SerializedErrorSchema } from './errors.js';
import { IdentifierSchema, JsonObjectSchema, JsonValueSchema } from './json.js';

export const PermissionModeSchema = z.enum(['ask', 'auto-edit', 'full-access']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto-edit';

export const ToolCallSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).max(128),
  arguments: JsonObjectSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolDescriptorSchema = z.strictObject({
  name: ToolCallSchema.shape.name,
  description: z.string().min(1),
  inputSchema: JsonObjectSchema,
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const ApprovalRequestSchema = z.strictObject({
  id: IdentifierSchema,
  toolCall: ToolCallSchema,
  workspace: z.string().min(1),
  cwd: z.string().min(1).optional(),
  summary: z.string().min(1),
  scope: z.array(z.string()).min(1),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export const ApprovalDecisionSchema = z.strictObject({
  requestId: IdentifierSchema,
  decision: z.enum(['approved', 'denied', 'cancelled']),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApprovalHandler = (request: ApprovalRequest, options: { signal: AbortSignal }) => Promise<ApprovalDecision>;

const toolResultFields = {
  toolCallId: IdentifierSchema,
  durationMs: z.number().finite().nonnegative(),
  truncated: z.boolean().default(false),
};
export const ToolResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...toolResultFields, status: z.literal('success'), output: JsonValueSchema }),
  z.strictObject({ ...toolResultFields, status: z.literal('error'), error: SerializedErrorSchema }),
  z.strictObject({ ...toolResultFields, status: z.literal('approval_required'), approval: ApprovalRequestSchema }),
  z.strictObject({ ...toolResultFields, status: z.literal('denied'), error: SerializedErrorSchema }),
  z.strictObject({ ...toolResultFields, status: z.literal('cancelled'), error: SerializedErrorSchema }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ModelMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: IdentifierSchema.optional(),
}).superRefine((message, context) => {
  if (message.role === 'tool' && message.toolCallId === undefined) {
    context.addIssue({ code: 'custom', message: 'Tool messages must identify their tool call' });
  }
  if (message.role !== 'tool' && message.toolCallId !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only tool messages may contain a tool call ID' });
  }
  if (message.role !== 'assistant' && message.toolCalls !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only assistant messages may contain tool calls' });
  }
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const ModelRequestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(ModelMessageSchema).min(1),
  tools: z.array(ToolDescriptorSchema).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

/** Missing usage is unknown and must remain null rather than being reported as zero. */
export const ModelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const ModelEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
  z.strictObject({ type: z.literal('tool_call'), call: ToolCallSchema }),
  z.strictObject({ type: z.literal('usage'), usage: ModelUsageSchema }),
  z.strictObject({ type: z.literal('done'), finishReason: z.enum(['stop', 'tool_calls', 'length']) }),
]);
export type ModelEvent = z.infer<typeof ModelEventSchema>;
export interface ModelRuntime {
  stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelEvent>;
}

export const ExecutionStateSchema = z.enum([
  'created', 'running', 'awaiting_approval', 'verifying', 'recovering',
  'completed', 'failed', 'cancelled', 'timed_out', 'approval_required', 'needs_review',
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export const ExecutionRequestSchema = z.strictObject({
  sessionId: IdentifierSchema,
  executionId: IdentifierSchema,
  task: z.string().min(1),
  workspace: z.string().min(1),
  permissions: PermissionModeSchema.default(DEFAULT_PERMISSION_MODE),
  budget: BudgetLimitsSchema.default(() => BudgetLimitsSchema.parse({})),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const VerificationCheckSchema = z.strictObject({
  name: z.string().min(1),
  command: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  status: z.enum(['passed', 'failed', 'cancelled', 'timed_out', 'not_run']),
  evidence: z.string(),
  failureReason: z.string().optional(),
}).superRefine((check, context) => {
  if (check.status !== 'not_run' && check.command.length === 0) {
    context.addIssue({ code: 'custom', message: 'An executed verification check must identify its command' });
  }
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;
export const VerificationReportSchema = z.strictObject({
  passed: z.boolean(),
  checks: z.array(VerificationCheckSchema),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
