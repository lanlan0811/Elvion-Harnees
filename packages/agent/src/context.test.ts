import { describe, expect, it } from 'vitest';
import { BudgetTracker, type ModelMessage, type ModelRequest, type ModelRuntime } from '@elvion/kernel';
import { ToolRuntime } from '@elvion/tool';
import { runAgent } from './index.js';

describe('Agent context integration', () => {
  it('persists compressed decisions as user evidence and supplies real acceptance and remaining work', async () => {
    const requests: ModelRequest[] = [];
    const runtime: ModelRuntime = { async *stream(request) {
      requests.push(request);
      if (request.messages[0]?.content.startsWith('Summarize coding history')) {
        yield { type: 'text_delta', text: JSON.stringify({ decisions: ['Preserve ESM exports'], completed: ['Updated function'], remaining: ['Run checks'] }) };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      } else { yield { type: 'text_delta', text: 'Ready for independent verification' }; }
      yield { type: 'done', finishReason: 'stop' };
    } };
    const messages: ModelMessage[] = Array.from({ length: 15 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}: ${'project observation '.repeat(40)}` }));
    const events = []; const budget = new BudgetTracker(); const savedTurns: number[] = [];
    for await (const event of runAgent({ runtime, model: 'test', tools: new ToolRuntime(), workspace: process.cwd(), permissionMode: 'ask', signal: new AbortController().signal, budget, goal: 'Fix existing API', acceptance: ['Tests pass'], decisions: ['Do not rename API'], remaining: ['Run checks'], maxContextCharacters: 6000, onBeforeModelTurn: async () => { savedTurns.push(budget.snapshot().turns); }, messages })) events.push(event);
    expect(events.some(event => event.type === 'agent.context_compacted')).toBe(true);
    expect(events.filter(event => event.type === 'model.usage').every(event => event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload['source'] === 'context-compaction')).toBe(true);
    expect(events.filter(event => event.type === 'model.usage').length).toBe(requests.length - 1);
    expect(events.at(-1)?.type).toBe('agent.delivery');
    const actual = requests.at(-1)!;
    expect(JSON.stringify(actual.messages).length).toBeLessThanOrEqual(6000);
    expect(actual.messages.filter(message => message.role === 'system')).toHaveLength(1);
    const requirements = JSON.parse(actual.messages[1]!.content);
    expect(requirements).toMatchObject({ goal: 'Fix existing API', acceptance: ['Tests pass'], decisions: ['Do not rename API'], remaining: ['Run checks'] });
    expect(messages.some(message => message.role === 'user' && message.content.includes('Preserve ESM exports'))).toBe(true);
    expect(budget.snapshot().turns).toBe(requests.length);
    expect(savedTurns).toEqual(Array.from({ length: requests.length }, (_, index) => index + 1));
  });

  it('preserves observed compression usage when a later summary fails', async () => {
    let requests = 0;
    const runtime: ModelRuntime = { async *stream() {
      requests++;
      if (requests > 1) throw new Error('Disconnected during later compression');
      yield { type: 'text_delta', text: JSON.stringify({ decisions: ['Keep API'], completed: [], remaining: ['Checks'] }) };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      yield { type: 'done', finishReason: 'stop' };
    } };
    const messages: ModelMessage[] = Array.from({ length: 16 }, () => ({ role: 'user', content: 'history '.repeat(100) }));
    const iterator = runAgent({ runtime, model: 'test', tools: new ToolRuntime(), workspace: process.cwd(), permissionMode: 'ask', signal: new AbortController().signal, budget: new BudgetTracker(), goal: 'Fix API', maxContextCharacters: 4000, messages })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'model.usage', payload: { totalTokens: 15, source: 'context-compaction' } });
    await expect(iterator.next()).rejects.toThrow('Disconnected during later compression');
    expect(messages.some(message => message.content.includes('untrustedContextMemory'))).toBe(false);
  });

  it('does not enter an ordinary provider turn cancelled during audit persistence', async () => {
    const controller = new AbortController(); let requested = false;
    const runtime: ModelRuntime = { async *stream() { requested = true; yield { type: 'done', finishReason: 'stop' }; } };
    const iterator = runAgent({ runtime, model: 'test', tools: new ToolRuntime(), workspace: process.cwd(), permissionMode: 'ask', signal: controller.signal, budget: new BudgetTracker(), goal: 'Fix API', messages: [], onBeforeModelTurn: async () => { controller.abort(); } })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('agent.turn');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(requested).toBe(false);
  });
});
