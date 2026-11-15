import { z } from 'zod';
import { ModelMessageSchema, PermissionModeSchema, ExecutionStateSchema, EventEnvelopeSchema } from '@elvion/kernel';

export const SessionSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  workspace: z.string().min(1),
  providerId: z.string().min(1),
  permissions: PermissionModeSchema,
  state: ExecutionStateSchema,
  task: z.string(),
  messages: z.array(ModelMessageSchema),
  lastSequence: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export const RepositoryRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ id: z.number().int(), operation: z.literal('save'), snapshot: SessionSnapshotSchema, events: z.array(EventEnvelopeSchema) }),
  z.strictObject({ id: z.number().int(), operation: z.literal('get'), sessionId: z.uuid() }),
  z.strictObject({ id: z.number().int(), operation: z.literal('list') }),
  z.strictObject({ id: z.number().int(), operation: z.literal('events'), sessionId: z.uuid() }),
  z.strictObject({ id: z.number().int(), operation: z.literal('close') }),
]);
