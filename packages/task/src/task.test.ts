import { describe, expect, it } from 'vitest';
import { BudgetTracker, type ModelEvent, type ModelRequest, type ModelRuntime } from '@elvion/kernel';
import { planTask, TaskGraph, validateTaskPlan } from './index.js';
const nodes = [
  { id: 'base', title: 'Implement verified foundation', dependsOn: [], acceptance: ['Foundation tests pass'] },
  { id: 'feature', title: 'Implement verified feature', dependsOn: ['base'], acceptance: ['Feature tests pass'] },
];
function fixture(output: unknown): { runtime: ModelRuntime; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { requests, runtime: { async *stream(request): AsyncIterable<ModelEvent> { requests.push(request); yield { type: 'text_delta', text: typeof output === 'string' ? output : JSON.stringify(output) }; yield { type: 'done', finishReason: 'stop' }; } } };
}
describe('bounded objective task planning', () => {
  it('uses a real no-tool model turn and validates a serial dependency plan', async () => {
    const { runtime, requests } = fixture(nodes);
    const budget = new BudgetTracker();
    const plan = await planTask({ runtime, model: 'model', goal: 'Build feature', signal: new AbortController().signal, budget });
    expect(requests[0]?.tools).toBeUndefined();
    expect(budget.snapshot().turns).toBe(1);
    const graph = new TaskGraph(plan);
    expect(graph.next()?.id).toBe('base');
    expect(graph.transition('base', 'running').status).toBe('running');
    expect(() => graph.transition('base', 'completed')).toThrow('verification');
    graph.transition('base', 'completed', { verified: true });
    expect(graph.next()?.id).toBe('feature');
  });
  it.each(['not JSON', [{ ...nodes[0], dependsOn: ['missing'] }], [{ ...nodes[0], status: 'completed' }], [{ ...nodes[0], dependsOn: ['base'] }]])('rejects invalid, precompleted and cyclic model plans', async (output) => {
    await expect(planTask({ ...fixture(output), model: 'm', goal: 'g', signal: new AbortController().signal, budget: new BudgetTracker() })).rejects.toMatchObject({ code: 'model_error' });
  });
  it('does not exceed the shared turn budget', async () => {
    const { runtime, requests } = fixture(nodes);
    const budget = new BudgetTracker({ maxTurns: 1 }); budget.consumeTurn();
    await expect(planTask({ runtime, model: 'm', goal: 'g', signal: new AbortController().signal, budget })).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(requests).toHaveLength(0);
  });
  it('cancels even while the provider iterator has not yielded', async () => {
    const controller = new AbortController();
    const runtime: ModelRuntime = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }) };
    const result = planTask({ runtime, model: 'm', goal: 'g', signal: controller.signal, budget: new BudgetTracker() });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('requires new explicit plans to start pending and rejects inconsistent restored running nodes', () => {
    expect(() => validateTaskPlan([{ ...nodes[0], status: 'running' }])).toThrow();
    expect(() => new TaskGraph([{ ...nodes[0], status: 'running' }, { ...nodes[1], status: 'running' }])).toThrow();
    expect(() => new TaskGraph([{ ...nodes[0], status: 'pending' }, { ...nodes[1], status: 'completed' }])).toThrow('dependencies');
  });
});
