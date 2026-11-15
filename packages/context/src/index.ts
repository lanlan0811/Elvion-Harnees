import { ElvionError, ModelMessageSchema, type ModelMessage } from '@elvion/kernel';
export interface ContextOptions { maxCharacters?: number; goal: string; acceptance?: string[]; decisions?: string[]; remaining?: string[] }
/** Preserve complete tool exchanges and task requirements within a conservative character budget. */
export function buildContext(messages: readonly ModelMessage[], options: ContextOptions): ModelMessage[] {
  const budget = options.maxCharacters ?? 60_000;
  if (!Number.isInteger(budget) || budget < 1024) throw new ElvionError('validation_error', 'Context budget must be at least 1024 characters');
  const validated = messages.map(message => ModelMessageSchema.parse(message));
  const system = validated.filter(m => m.role === 'system');
  const summary: ModelMessage = { role: 'user', content: JSON.stringify({ goal: options.goal, acceptance: options.acceptance ?? [], decisions: options.decisions ?? [], remaining: options.remaining ?? [] }) };
  const groups: ModelMessage[][] = [];
  let pendingCalls = new Set<string>();
  for (const message of validated.filter(m => m.role !== 'system')) {
    if (message.role === 'tool') {
      if (!message.toolCallId || !pendingCalls.delete(message.toolCallId)) throw new ElvionError('invalid_state', 'Orphan or duplicate tool result in context history');
      groups.at(-1)?.push(message);
    } else {
      if (pendingCalls.size) throw new ElvionError('invalid_state', 'Incomplete tool exchange in context history');
      const ids = message.toolCalls?.map(call => call.id) ?? [];
      pendingCalls = new Set(ids);
      if (pendingCalls.size !== ids.length) throw new ElvionError('invalid_state', 'Duplicate tool call IDs in context history');
      groups.push([message]);
    }
  }
  if (pendingCalls.size) throw new ElvionError('invalid_state', 'Incomplete tool exchange in context history');
  const selected: ModelMessage[][] = [];
  let size = JSON.stringify([...system, summary]).length;
  if (size > budget) throw new ElvionError('budget_exceeded', 'Task requirements exceed context budget');
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (!group) continue;
    const length = JSON.stringify(group).length - 2 + group.length;
    if (size + length > budget) {
      if (!selected.length) throw new ElvionError('budget_exceeded', 'Latest model exchange exceeds context budget');
      break;
    }
    selected.unshift(group); size += length;
  }
  return [...system, summary, ...selected.flat()];
}
