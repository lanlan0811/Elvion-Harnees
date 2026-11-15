import { buildContext } from '@elvion/context';
import { buildSystemPrompt } from '@elvion/prompt';
import { ToolRuntime } from '@elvion/tool';
import { BudgetTracker, ElvionError, raceWithSignal, throwIfAborted, ModelEventSchema, type ApprovalHandler, type JsonValue, type ModelEvent, type ModelMessage, type ModelRuntime, type PermissionMode, type ToolCall } from '@elvion/kernel';
import { createSensitiveRedactor } from './redaction.js';
export { createSensitiveRedactor } from './redaction.js';

export interface AgentEvent { type: string; payload: JsonValue }
export interface AgentOptions {
  runtime: ModelRuntime; model: string; tools: ToolRuntime; workspace: string;
  permissionMode: PermissionMode; signal: AbortSignal; budget: BudgetTracker;
  goal: string; messages: ModelMessage[]; approve?: ApprovalHandler;
}
async function* cancellableModelEvents(stream: AsyncIterable<ModelEvent>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await raceWithSignal(iterator.next(), signal);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (signal.aborted) void iterator.return?.().catch(() => undefined);
    else await iterator.return?.();
  }
}
/** Agent owns one reasoning loop. Execution owns verification and overall task completion. */
export async function* runAgent(options: AgentOptions): AsyncIterable<AgentEvent> {
  const { messages, signal, budget } = options;
  const policy = buildSystemPrompt();
  const history = messages.filter(message => message.role !== 'system');
  messages.splice(0, messages.length, { role: 'system', content: policy }, ...history);
  const redact = createSensitiveRedactor();
  while (true) {
    throwIfAborted(signal); budget.consumeTurn();
    const calls: ToolCall[] = []; const ids = new Set<string>(); let text = ''; let done = false; let finishReason = '';
    const textStream = redact.stream();
    yield { type: 'agent.turn', payload: { turn: budget.snapshot().turns } };
    for await (const raw of cancellableModelEvents(options.runtime.stream({ model: options.model, messages: redact.value(buildContext(messages, { goal: options.goal })), tools: options.tools.descriptors() }, { signal }), signal)) {
      throwIfAborted(signal); budget.assertTimeRemaining();
      const event = ModelEventSchema.parse(raw);
      if (done) throw new ElvionError('model_error', 'Model emitted events after completion');
      if (event.type === 'text_delta') {
        text += event.text;
        if (text.length > 2_000_000) throw new ElvionError('budget_exceeded', 'Model text exceeded its output budget');
        const safe = textStream.push(event.text);
        if (safe) yield { type: 'model.text', payload: { text: safe } };
      }
      else if (event.type === 'tool_call') {
        if (ids.has(event.call.id)) throw new ElvionError('model_error', 'Duplicate tool call ID');
        ids.add(event.call.id); calls.push(event.call);
      } else if (event.type === 'usage') yield { type: 'model.usage', payload: event.usage };
      else { done = true; finishReason = event.finishReason; }
    }
    if (!done) throw new ElvionError('model_error', 'Model stream ended before completion');
    if (finishReason === 'length') throw new ElvionError('model_error', 'Model output limit reached before completion');
    if ((finishReason === 'tool_calls') !== (calls.length > 0)) throw new ElvionError('model_error', 'Model finish reason does not match its tool calls');
    const tail = textStream.finish();
    if (tail) yield { type: 'model.text', payload: { text: tail } };
    text = redact.text(text);
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) });
    yield { type: 'agent.message', payload: redact.value(messages.at(-1)) as unknown as JsonValue };
    if (!calls.length) {
      if (!text.trim()) throw new ElvionError('model_error', 'Model returned an empty delivery');
      yield { type: 'agent.delivery', payload: { text } }; return;
    }
    for (const call of calls) {
      throwIfAborted(signal); budget.consumeToolCall();
      yield { type: 'tool.started', payload: redact.value(call) };
      const approve = options.approve;
      const result = await options.tools.execute(call, { workspace: options.workspace, permissionMode: options.permissionMode, signal, ...(approve ? { approve: (request, approvalOptions) => approve(redact.value(request), approvalOptions) } : {}) });
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(redact.value(result)) });
      yield { type: 'tool.finished', payload: redact.value(result) as unknown as JsonValue };
      if (result.status === 'error') {
        const details = result.error.details;
        const rollbackFailures = details?.['rollbackFailures'];
        if (details?.['requiresReview'] === true || (Array.isArray(rollbackFailures) && rollbackFailures.length > 0)) {
          throw new ElvionError('conflict', 'Tool side effects are uncertain; inspect the workspace before continuing', {
            details: { ...details, requiresReview: true, toolCallId: call.id, toolName: call.name },
          });
        }
      }
      if (result.status === 'approval_required') throw new ElvionError('approval_required', 'Tool execution requires approval');
      if (result.status === 'cancelled') throw new ElvionError('cancelled', 'Tool execution was cancelled');
      if (result.status === 'denied') throw new ElvionError('permission_denied', 'Tool execution was denied');
    }
  }
}
