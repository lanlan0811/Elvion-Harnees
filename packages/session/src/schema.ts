import { z } from 'zod';
import { BudgetLimitsSchema, BudgetUsageSchema, ModelMessageSchema, PermissionModeSchema, ExecutionStateSchema, EventEnvelopeSchema, VerificationReportSchema } from '@elvion/kernel';

export const ExecutionCheckpointSchema = z.strictObject({
  version: z.literal(1), model: z.string().min(1),
  phase: z.enum(['planning', 'agent', 'verification', 'verification_result', 'between_tasks', 'completed', 'stopped']),
  safeToResume: z.boolean(),
  tasks: z.array(z.strictObject({ id: z.string().min(1), title: z.string().min(1), dependsOn: z.array(z.string().min(1)), acceptance: z.array(z.string().min(1)).min(1), status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']) })).max(20),
  currentTaskId: z.string().min(1).nullable(),
  budget: z.strictObject({ limits: BudgetLimitsSchema, usage: BudgetUsageSchema }),
  verificationBaseline: z.strictObject({ manager: z.enum(['npm', 'pnpm', 'yarn']), packageManager: z.string().nullable(), scripts: z.record(z.string(), z.string()) }).nullable(),
  baselineCaptured: z.boolean(),
  lastReport: VerificationReportSchema.optional(),
}).superRefine((checkpoint, context) => {
  const fail = (message: string): void => { context.addIssue({ code: 'custom', message }); };
  const ids = new Set(checkpoint.tasks.map(task => task.id));
  if (ids.size !== checkpoint.tasks.length) fail('Duplicate checkpoint task IDs');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { fail('Checkpoint task dependency cycle'); return; }
    if (visited.has(id)) return;
    const task = checkpoint.tasks.find(node => node.id === id);
    if (!task) { fail('Missing checkpoint task dependency'); return; }
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const task of checkpoint.tasks) {
    visit(task.id);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) fail('Duplicate checkpoint task dependencies');
    if (['running', 'completed'].includes(task.status) && task.dependsOn.some(id => checkpoint.tasks.find(node => node.id === id)?.status !== 'completed')) fail('Checkpoint task has incomplete dependencies');
  }
  if (checkpoint.tasks.filter(task => task.status === 'running').length > 1) fail('Multiple running checkpoint tasks');
  if (checkpoint.currentTaskId && !ids.has(checkpoint.currentTaskId)) fail('Unknown checkpoint current task');
  if (['agent', 'verification', 'verification_result'].includes(checkpoint.phase) && checkpoint.tasks.find(task => task.id === checkpoint.currentTaskId)?.status !== 'running') fail('Active checkpoint requires one running current task');
  if (checkpoint.phase === 'verification_result' && !checkpoint.lastReport) fail('Verification result checkpoint requires its report');
  if (checkpoint.lastReport && (checkpoint.lastReport.passed !== (checkpoint.lastReport.checks.length > 0 && checkpoint.lastReport.checks.every(check => check.status === 'passed' && check.exitCode === 0)))) fail('Verification conclusion does not match objective check results');
  if (checkpoint.safeToResume && checkpoint.phase !== 'planning' && checkpoint.phase !== 'stopped' && !checkpoint.baselineCaptured) fail('Safe execution checkpoint requires a captured verification baseline');
  if (checkpoint.safeToResume && ['planning', 'between_tasks', 'completed'].includes(checkpoint.phase) && (checkpoint.currentTaskId !== null || checkpoint.tasks.some(task => task.status === 'running'))) fail('Checkpoint boundary cannot retain a running task');
  if (checkpoint.safeToResume && checkpoint.phase === 'between_tasks' && checkpoint.tasks.some(task => ['failed', 'cancelled'].includes(task.status))) fail('Failed task graph cannot continue as a stable boundary');
  if (checkpoint.phase === 'completed' && (checkpoint.tasks.length === 0 || checkpoint.tasks.some(task => task.status !== 'completed') || !checkpoint.lastReport?.passed)) fail('Completed checkpoint requires verified completed tasks');
  const { limits, usage } = checkpoint.budget;
  if (usage.turns > limits.maxTurns || usage.toolCalls > limits.maxToolCalls || usage.retries > limits.maxRetries || usage.repairs > limits.maxRepairs) fail('Checkpoint usage exceeds budget limits');
});
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpointSchema>;

export const SessionSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  workspace: z.string().min(1),
  providerId: z.string().min(1),
  permissions: PermissionModeSchema,
  state: ExecutionStateSchema,
  task: z.string(),
  messages: z.array(ModelMessageSchema),
  checkpoint: ExecutionCheckpointSchema.optional(),
  lastSequence: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((snapshot, context) => {
  const checkpoint = snapshot.checkpoint; if (!checkpoint) return;
  const fail = (message: string): void => { context.addIssue({ code: 'custom', message }); };
  if (snapshot.state === 'completed' && (checkpoint.phase !== 'completed' || !checkpoint.safeToResume)) fail('Completed snapshot requires a safe completed checkpoint');
  if (checkpoint.phase === 'completed' && snapshot.state !== 'completed') fail('Completed checkpoint requires a completed snapshot');
  const stoppedStates = ['failed', 'cancelled', 'timed_out', 'approval_required', 'needs_review'];
  if (checkpoint.phase === 'stopped' && !stoppedStates.includes(snapshot.state)) fail('Stopped checkpoint requires a terminal execution state');
  if (['failed', 'cancelled', 'timed_out', 'approval_required'].includes(snapshot.state) && checkpoint.phase !== 'stopped') fail('Terminal execution state requires a stopped checkpoint');
  if (snapshot.state === 'awaiting_approval' && checkpoint.safeToResume) fail('Pending approval cannot be a safe checkpoint');
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export const RepositoryRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ id: z.number().int(), operation: z.literal('save'), snapshot: SessionSnapshotSchema, events: z.array(EventEnvelopeSchema) }),
  z.strictObject({ id: z.number().int(), operation: z.literal('get'), sessionId: z.uuid() }),
  z.strictObject({ id: z.number().int(), operation: z.literal('list') }),
  z.strictObject({ id: z.number().int(), operation: z.literal('events'), sessionId: z.uuid() }),
  z.strictObject({ id: z.number().int(), operation: z.literal('close') }),
]);
