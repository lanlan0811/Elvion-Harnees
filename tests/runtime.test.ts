import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../runtime/agent.js';
import { SessionStore } from '../runtime/session.js';
import { contextBudget, estimateInput } from '../runtime/context.js';
import type { ModelProfile, ProviderAdapter, ToolExecutor } from '../core/types.js';
const dirs: string[] = []; const agents: AgentRuntime[] = [];
const profile: ModelProfile = { id: 'a', name: 'A', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', apiKey: 'secret-test-key', model: 'custom', contextWindow: 100_000, maxOutputTokens: 5000 };
async function setup(adapter: ProviderAdapter, executor: ToolExecutor = { definitions: [], execute: async () => ({ content: 'done' }) }) { const home = await mkdtemp(join(tmpdir(), 'elvion-agent-')); dirs.push(home); const store = await SessionStore.create(home, home); const agent = new AgentRuntime({ store, config: { version: 1, profiles: [profile, { ...profile, id: 'b', name: 'B' }], activeProfileId: 'a' }, executor, providerFactory: () => adapter }); agents.push(agent); return { home, agent, store }; }
afterEach(async () => { for (const a of agents.splice(0)) await a.close(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
describe('单Agent循环', () => {
  it('loads every prompt and publishes its context before the first request', async () => {
    const contents = await Promise.all(['system.md', 'agent.md', 'tools.md'].map(file => readFile(new URL('../prompts/' + file, import.meta.url), 'utf8')));
    const expected = contents.map(content => content.trim()).join('\n\n');
    const stream = vi.fn(async function* () { yield { type: 'done' as const, reason: 'stop' }; });
    const { agent, store } = await setup({ stream });
    const updates: number[] = []; agent.subscribe(snapshot => updates.push(snapshot.contextPercent));
    await agent.ready(); expect(store.latestState()?.messages[0]?.content).toBe(expected);
    expect(stream).not.toHaveBeenCalled(); expect(agent.getSnapshot().estimated).toBe(true);
    const percent = estimateInput([{ role: 'system', content: expected }], []) / profile.contextWindow * 100;
    expect(agent.getSnapshot().contextPercent).toBe(percent); expect(updates).toContain(percent);
    await agent.send('你好'); expect(stream).toHaveBeenCalledOnce();
  });
  it('counts prompts, tools and new messages across turns without reported usage', async () => {
    const adapter: ProviderAdapter = { async *stream() { yield { type: 'text', text: '已核实回复'.repeat(20) }; yield { type: 'done', reason: 'stop' }; } };
    const tools: ToolExecutor = { definitions: [{ name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], execute: async () => ({ content: 'unused' }) };
    const { agent, store } = await setup(adapter, tools); await agent.ready();
    const expected = () => estimateInput(store.latestState()!.messages, tools.definitions) / profile.contextWindow * 100;
    const initial = agent.getSnapshot().contextPercent; expect(initial).toBe(expected());
    await agent.send('第一轮'); const first = agent.getSnapshot().contextPercent; expect(first).toBeGreaterThan(initial); expect(first).toBe(expected());
    await agent.send('第二轮'); expect(agent.getSnapshot().contextPercent).toBeGreaterThan(first); expect(agent.getSnapshot().contextPercent).toBe(expected()); expect(agent.getSnapshot().estimated).toBe(true);
    agent.updateConfig({ version: 1, profiles: [] }); expect(agent.getSnapshot().contextPercent).toBe(0);
  });
  it('refreshes old prompts on resume while preserving summaries and completed history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'elvion-prompts-')); dirs.push(home);
    const store = await SessionStore.create(home, home);
    const history = [{ role: 'user' as const, content: '保留用户要求' }, { role: 'assistant' as const, content: '原始回答', toolCalls: [{ id: 'done', name: 'read_file', arguments: { path: 'a' } }] }, { role: 'tool' as const, toolCallId: 'done', content: '已确认结果' }, { role: 'system' as const, content: '本会话压缩摘要：旧摘要' }];
    await store.append('state', { messages: [{ role: 'system', content: '过期系统提示' }, ...history], entries: [], profileId: profile.id, todos: [] });
    await store.close(); const resumed = await SessionStore.resume(store.info.id, home);
    let executed = 0; let requests = 0;
    const contents = await Promise.all(['system.md', 'agent.md', 'tools.md'].map(file => readFile(new URL('../prompts/' + file, import.meta.url), 'utf8')));
    const expected = contents.map(content => content.trim()).join('\n\n');
    const adapter: ProviderAdapter = { async *stream(request) { requests++; expect(request.messages.slice(0, -1)).toEqual([{ role: 'system', content: expected }, ...history]); yield { type: 'text', text: '继续' }; yield { type: 'done', reason: 'stop' }; } };
    const agent = new AgentRuntime({ store: resumed, config: { version: 1, profiles: [profile], activeProfileId: profile.id }, executor: { definitions: [], execute: async () => { executed++; return { content: '不能重放' }; } }, providerFactory: () => adapter }); agents.push(agent);
    await agent.send('继续'); expect(requests).toBe(1); expect(executed).toBe(0); expect(agent.getSnapshot().status).toBe('idle');
    expect(resumed.latestState()?.messages.filter(message => message.content === expected)).toHaveLength(1);
  });
  it('闭合工具调用后才发下一次请求，并脱敏落盘', async () => { let requests = 0; const adapter: ProviderAdapter = { async *stream(request) { requests++; if (requests === 1) { yield { type: 'text', text: 'checking' }; yield { type: 'tool', call: { id: 't', name: 'read_file', arguments: { path: 'x' } } }; } else { expect(request.messages.at(-1)?.role).toBe('tool'); yield { type: 'text', text: 'secret-test-key finished' }; } yield { type: 'done', reason: 'stop' }; } }; const { agent, store } = await setup(adapter); await agent.send('测试'); expect(requests).toBe(2); expect(agent.getSnapshot().status).toBe('idle'); expect(agent.getSnapshot().entries.at(-1)?.content).toContain('[REDACTED]'); expect(await readFile(join(store.dir, 'events.jsonl'), 'utf8')).not.toContain('secret-test-key'); });
  it('模式切换不抢当前轮，下一轮才生效', async () => { const adapter: ProviderAdapter = { async *stream() { yield { type: 'text', text: 'response' }; yield { type: 'done', reason: 'stop' }; } }; const { agent } = await setup(adapter); let selected = false; agent.subscribe(s => { if (s.status === 'requesting' && !selected) { selected = true; agent.selectProfile('b'); expect(agent.getSnapshot().profile?.id).toBe('a'); } }); await agent.send('hello'); expect(agent.getSnapshot().profile?.id).toBe('b'); });
  it('断流不会执行已收到的工具事件', async () => { let calls = 0; const adapter: ProviderAdapter = { async *stream() { yield { type: 'tool', call: { id: 't', name: 'write_file', arguments: {} } }; throw new Error('connection lost'); } }; const { agent } = await setup(adapter, { definitions: [], execute: async () => { calls++; return { content: 'bad' }; } }); await agent.send('hello'); expect(calls).toBe(0); expect(agent.getSnapshot().status).toBe('failed'); });
  it('默认每次询问，拒绝不执行；重入草稿不排队', async () => { const adapter: ProviderAdapter = { async *stream() { yield { type: 'tool', call: { id: 't', name: 'bash', arguments: {} } }; yield { type: 'done', reason: 'stop' }; } }; let requests = 0; const { agent } = await setup({ async *stream(r) { if (++requests === 1) yield* adapter.stream(r); else { yield { type: 'text', text: 'done' }; yield { type: 'done', reason: 'stop' }; } } }, { definitions: [], execute: async (_call, context) => ({ content: await context.approve({ id: 't', tool: 'bash', title: '确认', details: 'echo hi' }) ? 'allowed' : 'denied' }) }); expect(agent.getSnapshot().permission).toBe('ask'); agent.subscribe(s => { if (s.approval) queueMicrotask(() => agent.approve(false)); }); const first = agent.send('run'); await expect(agent.send('draft')).rejects.toThrow('尚未结束'); await first; expect(agent.getSnapshot().entries.find(e => e.kind === 'tool')?.output).toBe('denied'); });
  it('输出按剩余容量缩减，不总预留最大输出', () => { expect(contextBudget(profile, 96_000).maxOutput).toBe(3000); expect(contextBudget(profile, 101_000).maxOutput).toBe(0); });
});
