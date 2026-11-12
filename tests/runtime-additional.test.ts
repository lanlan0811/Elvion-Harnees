import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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
  it('redacts credentials with JSON escapes inside nested provider metadata', async () => {
    const secret = 'secret-"quoted\\credential';
    const escapedProfile = { ...profile, apiKey: secret };
    const adapter: ProviderAdapter = { async *stream() { yield { type: 'provider-data', items: [{ type: 'reasoning', nested: { text: secret } }] }; yield { type: 'text', text: 'done' }; yield { type: 'done', reason: 'stop' }; } };
    const { agent, store } = await setup({ version: 1, profiles: [escapedProfile], activeProfileId: escapedProfile.id }, adapter);
    await agent.send('test'); const raw = await readFile(join(store.dir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(raw).toContain('[REDACTED]');
  });
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
    await store.append('state', { messages: [{ role: 'system', content: 'system' }, { role: 'assistant', content: 'old', providerData: { profileId: profile.id, protocol: profile.protocol, items: [{ type: 'reasoning', encrypted_content: 'signed-state' }] } }], entries: [], profileId: profile.id, profileFingerprint: createHash('sha256').update(JSON.stringify({ id: profile.id, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model })).digest('hex'), todos: [] });
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

  it('resume preserves private provider data only for an identical persisted profile fingerprint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'elvion-fingerprint-')); roots.push(home);
    const initialAdapter: ProviderAdapter = { async *stream() { yield { type: 'provider-data', items: [{ type: 'reasoning', encrypted_content: 'private-state' }] }; yield { type: 'text', text: 'previous result' }; yield { type: 'done', reason: 'stop' }; } };
    const initialStore = await SessionStore.create(home, home);
    const initialAgent = new AgentRuntime({ store: initialStore, config: { version: 1, profiles: [profile], activeProfileId: profile.id }, executor, providerFactory: () => initialAdapter });
    await initialAgent.send('first'); await initialAgent.close();
    expect(initialStore.latestState()?.profileFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const saved = initialStore.latestState()!;
    const cases: { target: ModelProfile; preserve: boolean; legacy?: boolean; staleIdentity?: boolean }[] = [
      { target: { ...profile }, preserve: true },
      { target: { ...profile, model: 'new-model-family' }, preserve: false },
      { target: { ...profile, baseUrl: 'https://other.example.com/v1' }, preserve: false },
      { target: { ...profile, protocol: 'anthropic' }, preserve: false },
      { target: { ...profile, id: 'replacement' }, preserve: false },
      { target: { ...profile }, preserve: false, legacy: true },
      { target: { ...profile }, preserve: false, staleIdentity: true },
    ];
    for (const item of cases) {
      const stateStore = await SessionStore.create(home, home);
      const state = structuredClone(saved); if (item.legacy) delete state.profileFingerprint;
      if (item.staleIdentity) state.profileFingerprint = createHash('sha256').update(JSON.stringify({ id: 'previous-id', protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model })).digest('hex');
      if (item.target.id !== profile.id) state.profileId = item.target.id;
      await stateStore.append('state', state);
      let requested = false;
      const adapter: ProviderAdapter = { async *stream(req) { requested = true; expect(req.messages.some(message => message.providerData)).toBe(item.preserve); expect(req.messages.some(message => message.content === 'previous result')).toBe(true); yield { type: 'text', text: 'continued' }; yield { type: 'done', reason: 'stop' }; } };
      const agent = new AgentRuntime({ store: stateStore, config: { version: 1, profiles: [item.target], activeProfileId: item.target.id }, executor, providerFactory: () => adapter });
      agents.push(agent); await agent.send('continue'); expect(requested).toBe(true); expect(agent.getSnapshot().status).toBe('idle');
    }
  });

  it('calibrated estimates never display as measured usage after messages or model change', async () => {
    const adapter: ProviderAdapter = { async *stream() { yield { type: 'usage', usage: { inputTokens: 1234, outputTokens: 10 } }; yield { type: 'text', text: 'new content' }; yield { type: 'done', reason: 'stop' }; } };
    const { agent } = await setup({ version: 1, profiles: [profile], activeProfileId: profile.id }, adapter);
    const observed: { percent: number; estimated: boolean }[] = [];
    agent.subscribe(snapshot => observed.push({ percent: snapshot.contextPercent, estimated: snapshot.estimated }));
    await agent.send('hello');
    expect(observed.some(value => !value.estimated && value.percent === 1.234)).toBe(true);
    expect(agent.getSnapshot().estimated).toBe(true);
    agent.updateConfig({ version: 1, profiles: [{ ...profile, contextWindow: 50000 }], activeProfileId: profile.id });
    expect(agent.getSnapshot().estimated).toBe(true);
  });

  it('replays durable tool-end results after the latest state without executing completed tools again', async () => {
    const home = await mkdtemp(join(tmpdir(), 'elvion-durable-result-')); roots.push(home);
    const crashed = await SessionStore.create(home, home);
    const calls = [{ id: 'durable-success', name: 'write_file', arguments: { path: 'a.ts', content: 'a' } }, { id: 'durable-failure', name: 'bash', arguments: { command: 'exit 1' } }, { id: 'interrupted', name: 'bash', arguments: { command: 'unknown' } }];
    const messages: Message[] = [{ role: 'user', content: 'perform work' }, { role: 'assistant', content: 'working', toolCalls: calls }];
    await crashed.append('tool-start', calls[0]);
    await crashed.append('state', { messages, entries: [{ id: 'card-success', kind: 'tool', content: 'write_file', timestamp: new Date().toISOString(), toolName: 'write_file', toolCall: calls[0], status: '执行中', output: '' }], profileId: profile.id, todos: [] });
    await crashed.append('tool-end', { id: calls[0]!.id, status: '完成', result: { content: 'durable write completed', metadata: { path: 'a.ts' } } });
    await crashed.append('tool-start', calls[1]);
    await crashed.append('tool-end', { id: calls[1]!.id, status: '失败', result: { content: 'durable exit 1', isError: true, metadata: { exitCode: 1 } } });
    await crashed.append('tool-start', calls[2]);
    const id = crashed.info.id; await crashed.close();
    const resumed = await SessionStore.resume(id, home);
    let executed = 0; let requested = 0;
    const noRepeat: ToolExecutor = { definitions: [], execute: async () => { executed++; return { content: 'must not run' }; } };
    const adapter: ProviderAdapter = { async *stream(req) { requested++; const results = req.messages.filter(message => message.role === 'tool'); expect(results.map(message => message.toolCallId)).toEqual(calls.map(call => call.id)); expect(results[0]?.content).toBe('durable write completed'); expect(results[1]?.content).toBe('durable exit 1'); expect(results[2]?.content).toContain('结果未知'); yield { type: 'text', text: 'reviewed durable results' }; yield { type: 'done', reason: 'stop' }; } };
    const agent = new AgentRuntime({ store: resumed, config: { version: 1, profiles: [profile], activeProfileId: profile.id }, executor: noRepeat, providerFactory: () => adapter }); agents.push(agent);
    const snapshot = agent.getSnapshot();
    expect(snapshot.entries.find(entry => entry.toolCall?.id === calls[0]!.id)).toMatchObject({ status: '完成', output: 'durable write completed', metadata: { path: 'a.ts', durableRecovery: true } });
    expect(snapshot.entries.find(entry => entry.toolCall?.id === calls[1]!.id)).toMatchObject({ status: '失败', output: 'durable exit 1' });
    expect(snapshot.entries.find(entry => entry.toolCall?.id === calls[2]!.id)).toMatchObject({ status: '结果未知' });
    expect(snapshot.entries.filter(entry => entry.content.includes('上次操作结果未知'))).toHaveLength(1);
    expect(requested).toBe(0); expect(executed).toBe(0);
    await agent.send('核对恢复结果'); expect(requested).toBe(1); expect(executed).toBe(0);
    expect(agent.getSnapshot().status).toBe('idle');
  });
});
