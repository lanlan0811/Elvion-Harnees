import { describe, expect, it } from 'vitest';
import { buildContext } from './index.js';
const call = { id: 'call', name: 'read_file', arguments: { path: 'a' } };
describe('context history integrity', () => {
  it('rejects orphan, duplicate and incomplete tool results', () => {
    expect(() => buildContext([{ role: 'tool', toolCallId: 'unknown', content: 'result' }], { goal: 'g' })).toThrow('Orphan');
    expect(() => buildContext([{ role: 'assistant', content: '', toolCalls: [call] }], { goal: 'g' })).toThrow('Incomplete');
    expect(() => buildContext([{ role: 'assistant', content: '', toolCalls: [call] }, { role: 'tool', toolCallId: 'call', content: 'x' }, { role: 'tool', toolCallId: 'call', content: 'x' }], { goal: 'g' })).toThrow('duplicate');
  });
  it('never exceeds the exact JSON budget at the boundary', () => {
    const selected = buildContext([{ role: 'user', content: 'x'.repeat(800) }], { goal: 'Goal', maxCharacters: 1024 });
    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(1024);
  });
});
