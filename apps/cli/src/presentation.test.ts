import { describe, expect, it } from 'vitest';
import { EventSequencer } from '@elvion/kernel';
import type { SessionSnapshot } from '@elvion/session';
import { presentApproval, projectExecutionEvent, restoreUiMessages } from './presentation.js';
import type { UiMessage } from './ui/types.js';

describe('structured execution presentation', () => {
  it('presents the resolved approval cwd and falls back only for legacy requests', () => {
    const request = { id: 'approval-cwd', toolCall: { id: 'call-cwd', name: 'bash', arguments: { command: 'pwd', cwd: 'src' } }, workspace: 'D:/project', summary: 'Run pwd', scope: ['D:/project/src'] };
    expect(presentApproval({ ...request, cwd: 'D:/project/src' })).toMatchObject({ id: 'approval-cwd', tool: 'bash', cwd: 'D:/project/src', scope: 'D:/project/src' });
    expect(presentApproval(request).cwd).toBe('D:/project');
  });
  it('updates task progress, actual diff output, unknown usage and objective delivery evidence', () => {
    const events = new EventSequencer({ sessionId: 'presentation-session' });
    let messages: UiMessage[] = [];
    const task = { id: 'edit', title: 'Change code', acceptance: ['npm test passes'], dependsOn: [], status: 'pending' };
    messages = projectExecutionEvent(messages, events.next('task.planned', { tasks: [task] }));
    messages = projectExecutionEvent(messages, events.next('task.started', { task }));
    expect(messages.find(message => message.kind === 'task')).toMatchObject({ status: 'running', text: 'Acceptance: npm test passes' });
    messages = projectExecutionEvent(messages, events.next('tool.started', { id: 'diff-1', name: 'diff', arguments: { paths: ['math.ts'] } }));
    messages = projectExecutionEvent(messages, events.next('tool.finished', { toolCallId: 'diff-1', status: 'success', output: { stdout: '--- a/math.ts\n+++ b/math.ts\n-old\n+new', exitCode: 0 } }));
    expect(messages.find(message => message.kind === 'diff')?.text).toContain('-old\n+new');
    messages = projectExecutionEvent(messages, events.next('model.usage', { inputTokens: null, outputTokens: 4, totalTokens: null }));
    expect(messages.find(message => message.kind === 'usage')?.text).toBe('Input: unknown | Output: 4 | Total: unknown');
    messages = projectExecutionEvent(messages, events.next('task.completed', { taskId: 'edit', tasks: [{ ...task, status: 'completed' }] }));
    const report = { passed: true, checks: [{ name: 'test', command: ['npm', 'run', 'test'], exitCode: 0, status: 'passed', evidence: 'actual test output' }] };
    messages = projectExecutionEvent(messages, events.next('execution.completed', { tasks: [{ ...task, status: 'completed' }], report, budget: { turns: 3, toolCalls: 5, repairs: 1 } }));
    expect(messages.filter(message => message.kind === 'task')).toHaveLength(1);
    expect(messages.find(message => message.kind === 'task')?.status).toBe('completed');
    expect(messages.at(-1)).toMatchObject({ kind: 'report', title: 'Delivery report' });
    expect(messages.at(-1)?.text).toContain('Command: npm run test');
    expect(messages.at(-1)?.text).toContain('exit 0');
    expect(messages.at(-1)?.text).toContain('actual test output');
    expect(messages.at(-1)?.text).toContain('3 turns / 5 tool calls / 1 repairs');
  });
  it.each(['failed', 'cancelled'])('reflects task %s without inventing completion', status => {
    const events = new EventSequencer({ sessionId: 'task-session' });
    const task = { id: 'task', title: 'Task', acceptance: ['Check'] };
    const initial = projectExecutionEvent([], events.next('task.started', { task }));
    const messages = projectExecutionEvent(initial, events.next(`task.${status}`, { taskId: 'task' }));
    expect(messages[0]?.status).toBe(status);
  });
  it('restores saved conversation, latest task state and report from durable events', () => {
    const events = new EventSequencer({ sessionId: 'restored' });
    const history = [events.next('execution.started', { task: '原始需求' }), events.next('model.text', { text: '已分析中文项目' }), events.next('task.planned', { tasks: [{ id: 'one', title: '修复', acceptance: ['test'], status: 'pending' }] }), events.next('task.completed', { taskId: 'one' }), events.next('verification.finished', { passed: true, checks: [{ name: 'test', command: ['npm', 'test'], exitCode: 0, status: 'passed', evidence: 'restored-proof' }] }), events.next('execution.completed', { report: { passed: true, checks: [] } })];
    const now = new Date().toISOString();
    const session: SessionSnapshot = { schemaVersion: 1, id: 'restored', providerId: 'local', permissions: 'ask', workspace: 'workspace', state: 'completed', task: '原始需求', messages: [], lastSequence: 6, createdAt: now, updatedAt: now };
    const messages = restoreUiMessages(session, history);
    expect(messages.find(message => message.kind === 'user')?.text).toBe('原始需求');
    expect(messages.find(message => message.kind === 'assistant')?.text).toBe('已分析中文项目');
    expect(messages.find(message => message.kind === 'task')?.status).toBe('completed');
    expect(messages.find(message => message.kind === 'verification')?.text).toContain('restored-proof');
    expect(messages.at(-1)?.kind).toBe('report');
  });
});
