import type { ApprovalRequest, EventEnvelope } from '@elvion/kernel';
import type { SessionSnapshot } from '@elvion/session';
import type { UiApproval, UiMessage } from './ui/types.js';
import { cleanText } from './ui/text.js';

export const MAX_UI_MESSAGES = 500;
export const MAX_UI_MESSAGE_CHARACTERS = 32_000;
export function presentApproval(request: ApprovalRequest): UiApproval { return { id: request.id, tool: request.toolCall.name, arguments: request.toolCall.arguments, cwd: request.cwd ?? request.workspace, scope: request.scope.join(', ') }; }
const omitted = '\n[Earlier output omitted from display; use the persisted event log for evidence.]\n';
function bounded(text: string): string { const value = cleanText(text); return value.length <= MAX_UI_MESSAGE_CHARACTERS ? value : omitted + value.slice(-(MAX_UI_MESSAGE_CHARACTERS - omitted.length)); }
export function appendUiMessage(messages: readonly UiMessage[], message: UiMessage): UiMessage[] { return [...messages.slice(-(MAX_UI_MESSAGES - 1)), { ...message, text: bounded(message.text) }]; }
export function appendAssistantText(messages: readonly UiMessage[], id: string, text: string): UiMessage[] {
  if (!messages.some(message => message.id === id)) return appendUiMessage(messages, { id, kind: 'assistant', text });
  return messages.slice(-MAX_UI_MESSAGES).map(message => message.id === id ? { ...message, text: bounded(message.text + text) } : message);
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function token(value: unknown): string { return typeof value === 'number' ? String(value) : 'unknown'; }
function upsert(messages: readonly UiMessage[], message: UiMessage): UiMessage[] { return messages.some(existing => existing.id === message.id) ? messages.map(existing => existing.id === message.id ? { ...message, text: bounded(message.text) } : existing) : appendUiMessage(messages, message); }
function taskMessage(value: unknown, sessionId: string, status?: string): UiMessage {
  const task = object(value);
  return { id: `task:${sessionId}:${string(task['id'])}`, kind: 'task', title: `Task ${string(task['id'])}: ${string(task['title'])}`, status: status ?? string(task['status'], 'pending'), text: [...array(task['acceptance']).map(value => `Acceptance: ${string(value)}`), ...(array(task['dependsOn']).length ? [`Depends on: ${array(task['dependsOn']).join(', ')}`] : [])].join('\n') };
}
export function verificationText(value: unknown): string {
  const report = object(value);
  return [`Verification: ${report['passed'] === true ? 'passed' : 'not passed'}`, ...array(report['checks']).flatMap(value => {
    const check = object(value);
    return [`${string(check['name'])}: ${string(check['status'], 'unknown')} | exit ${token(check['exitCode'])}`, `Command: ${array(check['command']).join(' ') || '(not run)'}`, string(check['evidence']), ...(check['failureReason'] ? [`Reason: ${string(check['failureReason'])}`] : [])];
  })].filter(Boolean).join('\n');
}
export function deliveryText(value: unknown, state = 'completed'): string {
  const payload = object(value); const budget = object(payload['budget']);
  return [`Execution: ${state}`, ...array(payload['tasks']).map(value => { const task = object(value); return `Task ${string(task['id'])}: ${string(task['title'])} — ${string(task['status'])}`; }), ...(payload['report'] ? [verificationText(payload['report'])] : []), ...(Object.keys(budget).length ? [`Budget: ${token(budget['turns'])} turns / ${token(budget['toolCalls'])} tool calls / ${token(budget['repairs'])} repairs`] : []), string(payload['reason']), string(object(payload['error'])['message'])].filter(Boolean).join('\n');
}
/** Present structured engine events without deriving engine state from model text. */
export function projectExecutionEvent(messages: readonly UiMessage[], event: EventEnvelope): UiMessage[] {
  const payload = object(event.payload); const id = `${event.sessionId}:${event.sequence}`; const scope = event.sessionId;
  if (event.type === 'model.text') {
    const previous = messages.at(-1); return appendAssistantText(messages, previous?.kind === 'assistant' ? previous.id : `assistant:${id}`, string(payload['text']));
  }
  if (event.type === 'model.usage') return appendUiMessage(messages, { id, kind: 'usage', title: 'Model usage', text: `Input: ${token(payload['inputTokens'])} | Output: ${token(payload['outputTokens'])} | Total: ${token(payload['totalTokens'])}` });
  if (event.type === 'task.planned') return array(payload['tasks']).reduce<UiMessage[]>((current, task) => upsert(current, taskMessage(task, scope)), [...messages]);
  if (event.type === 'task.started') return upsert(messages, taskMessage(payload['task'], scope, 'running'));
  if (['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) {
    if (Array.isArray(payload['tasks'])) return payload['tasks'].reduce<UiMessage[]>((current, task) => upsert(current, taskMessage(task, scope)), [...messages]);
    const taskId = `task:${scope}:${string(payload['taskId'], string(object(payload['task'])['id']))}`;
    return messages.some(message => message.id === taskId) ? messages.map(message => message.id === taskId ? { ...message, status: event.type.slice(5) } : message) : upsert(messages, taskMessage(payload['task'] ?? { id: payload['taskId'] }, scope, event.type.slice(5)));
  }
  if (event.type === 'tool.started') return upsert(messages, { id: `tool:${event.sessionId}:${string(payload['id'])}`, kind: 'tool', title: string(payload['name'], 'Tool'), status: 'running', text: JSON.stringify(payload['arguments'] ?? {}, null, 2) });
  if (event.type === 'tool.finished') {
    const toolId = `tool:${event.sessionId}:${string(payload['toolCallId'])}`; const previous = messages.find(message => message.id === toolId); const output = object(payload['output']);
    const changes = array(output['changeRecords']).map(value => { const change = object(value); return `${string(change['kind'])}: ${string(change['path'])}`; });
    const text = [string(output['stdout']), string(output['stderr']), string(output['content']), ...changes, string(object(payload['error'])['message'])].filter(Boolean).join('\n') || JSON.stringify(payload['output'] ?? payload, null, 2);
    const updated = upsert(messages, { id: toolId, kind: 'tool', title: previous?.title ?? 'Tool', status: `${string(payload['status'], 'unknown')}${output['exitCode'] !== undefined ? ` / exit ${token(output['exitCode'])}` : ''}`, text });
    return previous?.title === 'diff' && typeof output['stdout'] === 'string' ? appendUiMessage(updated, { id: `diff:${id}`, kind: 'diff', title: 'Diff', text: output['stdout'] }) : updated;
  }
  if (event.type === 'verification.finished') return appendUiMessage(messages, { id, kind: 'verification', title: 'Independent verification', status: payload['passed'] === true ? 'passed' : 'failed', text: verificationText(payload) });
  if (event.type.startsWith('execution.')) {
    const terminal = event.type.slice(10);
    const progress = messages.map(message => message.kind === 'task' && message.status === 'running' && ['failed', 'cancelled', 'timed_out', 'needs_review'].includes(terminal) ? { ...message, status: terminal } : message);
    return appendUiMessage(progress, { id, kind: event.type === 'execution.completed' ? 'report' : ['execution.failed', 'execution.needs_review'].includes(event.type) ? 'error' : 'system', title: event.type === 'execution.completed' ? 'Delivery report' : event.type, text: deliveryText(payload, terminal) });
  }
  if (event.type === 'verification.started' || event.type === 'task.planning' || event.type === 'session.restored') return appendUiMessage(messages, { id, kind: 'system', title: event.type, text: string(payload['reason'], string(payload['taskId'])) });
  return [...messages];
}
export function restoreUiMessages(session: SessionSnapshot, history: readonly EventEnvelope[]): UiMessage[] {
  let messages: UiMessage[] = [];
  for (const event of history) {
    if (event.type === 'execution.started') { const task = string(object(event.payload)['task']); if (task) messages = appendUiMessage(messages, { id: `user:${event.sessionId}:${event.sequence}`, kind: 'user', title: 'You', text: task }); }
    messages = projectExecutionEvent(messages, event);
  }
  if (!history.some(event => event.type === 'model.text')) {
    const conversation = session.messages.filter(message => message.role === 'user' || message.role === 'assistant').filter(message => Boolean(message.content)).map((message, index): UiMessage => ({ id: `saved:${session.id}:${index}`, kind: message.role === 'assistant' ? 'assistant' : 'user', text: message.content }));
    messages = [...conversation.map(message => ({ ...message, text: bounded(message.text) })), ...messages].slice(-MAX_UI_MESSAGES);
  }
  if (session.checkpoint) {
    for (const task of session.checkpoint.tasks) messages = upsert(messages, taskMessage(task, session.id));
    if (session.checkpoint.lastReport && !history.some(event => event.type === 'verification.finished')) messages = appendUiMessage(messages, { id: `saved-verification:${session.id}`, kind: 'verification', title: 'Saved independent verification', text: verificationText(session.checkpoint.lastReport) });
  }
  return messages;
}
