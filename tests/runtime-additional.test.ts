import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../runtime/agent.js';
import { SessionStore } from '../runtime/session.js';
import { compactMessages, contextBudget, estimateInput } from '../runtime/context.js';
import type { AppConfig, Message, ModelProfile, ProviderAdapter, ToolExecutor } from '../core/types.js';

const roots: string[] = []; const agents: AgentRuntime[] = [];
const profile: ModelProfile = { id: 'primary', name: '测试', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', apiKey: 'old-sensitive-credential', model: 'custom', contextWindow: 100000, maxOutputTokens: 5000 };
const executor: ToolExecutor = { definitions: [], execute: async () => ({ content: 'ok' }) };
async function setup(config: AppConfig, adapter: ProviderAdapter) {
  const home = await mkdtemp(join(tmpdir(), 'elvion-extra-')); roots.push(home);
  const store = await SessionStore.create(home, home);
  const agent = new AgentRuntime({ store, config, executor, providerFactory: () => adapter }); agents.push(agent);
  return { agent, store, home };
}
afterEach(async () => { for (const agent of agents.splice(0)) await agent.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('runtime failure recovery regressions', () => {
  it('a failed compact with no configured model does not leave the session permanently busy', async () => {
    const adapter: ProviderAdapter = { async *stream() { yield { type: 'done', reason: 'stop' }; } };
    const { agent } = await setup({ version: 1, profiles: [] }, adapter);
    await agent.compact().catch(() => undefined);
    await expect(agent.send('new task')).resolves.toBeUndefined();
    expect(agent.getSnapshot().status).toBe('failed');
  });
  it('changing API credentials mid-turn continues to redact the credential used by that turn', async () => {
    const adapter: ProviderAdapter = { async *stream() { yield { type: 'text', text: 'old-sensitive-credential' }; yield { type: 'done', reason: 'stop' }; } };
    const { agent, store } = await setup({ version: 1, profiles: [profile], activeProfileId: profile.id }, adapter);
    let changed = false;
    agent.subscribe(snapshot => { if (snapshot.status === 'requesting' && !changed) { changed = true; agent.updateConfig({ version: 1, profiles: [{ ...profile, apiKey: 'new-sensitive-credential' }], activeProfileId: profile.id }); } });
    await agent.send('hello');
    expect(agent.getSnapshot().entries.map(entry => entry.content).join(' ')).not.toContain('old-sensitive-credential');
    expect(await readFile(join(store.dir, 'events.jsonl'), 'utf8')).not.toContain('old-sensitive-credential');
  });
  it('changing the selected model config mid-turn leaves current provider-specific history intact', async () => {
    let checked = false;
    const adapter: ProviderAdapter = { async *stream(request) { checked = true; expect(request.profile.model).toBe('custom'); expect(request.messages.some(message => message.providerData?.items.length)).toBe(true); yield { type: 'text', text: 'ok' }; yield { type: 'done', reason: 'stop' }; } };
    const home = await mkdtemp(join(tmpdir(), 'elvion-extra-')); roots.push(home);
    const store = await SessionStore.create(home, home);
    await store.append('state', { messages: [{ role: 'system', content: 'system' }, { role: 'assistant', content: 'old', providerData: { profileId: profile.id, protocol: profile.protocol, items: [{ type: 'reasoning', encrypted_content: 'signed-state' }] } }], entries: [], profileId: profile.id, todos: [] });
    const agent = new AgentRuntime({ store, config: { version: 1, profiles: [profile], activeProfileId: profile.id }, executor, providerFactory: () => adapter }); agents.push(agent);
    let changed = false; agent.subscribe(snapshot => { if (snapshot.status === 'requesting' && !changed) { changed = true; agent.updateConfig({ version: 1, profiles: [{ ...profile, model: 'new-family' }], activeProfileId: profile.id }); } });
    await agent.send('continue');
    expect(checked).toBe(true); expect(agent.getSnapshot().status).toBe('idle');
  });
  it('compacts a long Chinese transcript using summary requests that each fit the configured window', async () => {
    const small = { ...profile, contextWindow: 4096, maxOutputTokens: 512 };
    const messages: Message[] = [{ role: 'system', content: '遵守当前任务' }, { role: 'user', content: '中文历史'.repeat(3000) }, { role: 'assistant', content: '已核实结果' }, { role: 'user', content: '接下来继续' }];
    let requests = 0; const adapter: ProviderAdapter = { async *stream(request) { requests++; const budget = contextBudget(small, estimateInput(request.messages, request.tools)); expect(budget.maxOutput).toBeGreaterThanOrEqual(request.maxOutputTokens); yield { type: 'text', text: '此前核实了旧任务，保留结果和约束。' }; yield { type: 'done', reason: 'stop' }; } };
    const result = await compactMessages({ messages, profile: small, apiKey: 'test', adapter, signal: new AbortController().signal, tools: [] });
    expect(requests).toBeGreaterThan(1); expect(result.at(-1)?.content).toBe('接下来继续');
  });
});
