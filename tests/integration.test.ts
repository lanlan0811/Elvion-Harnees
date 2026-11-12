import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../runtime/agent.js';
import { SessionStore } from '../runtime/session.js';
import { createProvider } from '../providers/index.js';
import { createToolExecutor } from '../tools/index.js';
import { inspectBash } from '../execution/bash.js';
import type { AppConfig, ModelProfile, Protocol, ToolCall } from '../core/types.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const frame = (data: unknown) => 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n';

function streamReply(res: ServerResponse, protocol: Protocol, calls: ToolCall[], text = '已完成并核实。'): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (protocol === 'openai-responses') {
    if (!calls.length) res.write(frame({ type: 'response.output_text.delta', delta: text }));
    res.end(frame({ type: 'response.completed', response: { status: 'completed', output: calls.length ? calls.map(call => ({ type: 'function_call', id: 'fc_' + call.id, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' })) : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3000, output_tokens: 50 } } }));
  } else if (protocol === 'openai-chat') {
    res.write(frame({ choices: [{ index: 0, delta: calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { content: text }, finish_reason: null }] }));
    res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 50 } }));
    res.end(frame('[DONE]'));
  } else {
    res.write(frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', usage: { input_tokens: 3000, output_tokens: 0 } } }));
    if (calls.length) for (const [index, call] of calls.entries()) {
      res.write(frame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
      res.write(frame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } }));
      res.write(frame({ type: 'content_block_stop', index }));
    } else {
      res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
      res.write(frame({ type: 'content_block_stop', index: 0 }));
    }
    res.write(frame({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 50 } }));
    res.end(frame({ type: 'message_stop' }));
  }
}

async function setup(protocol: Protocol, initialCalls: ToolCall[], options: { holdSecondRequest?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'elvion-integration-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, '中文 项目'); await mkdir(workspace);
  const requests: { url?: string; body: any; authorization?: string; apiKey?: string }[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: req.url, body, authorization: req.headers.authorization, apiKey: String(req.headers['x-api-key'] ?? '') });
      if (requests.length > 1 && options.holdSecondRequest) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); }
      else streamReply(res, protocol, requests.length === 1 ? initialCalls : []);
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing local server');
  const profile: ModelProfile = { id: protocol, name: '本地契约服务', protocol, model: 'fixture-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'integration-only-fake-key', contextWindow: 100000, maxOutputTokens: 5000 };
  const config: AppConfig = { version: 1, profiles: [profile], activeProfileId: profile.id };
  const store = await SessionStore.create(workspace, home);
  const agent = new AgentRuntime({ store, config, providerFactory: createProvider, executor: createToolExecutor() });
  let closed = false; cleanup.push(async () => { if (!closed) { closed = true; await agent.close(); } });
  const close = async () => { if (!closed) { closed = true; await agent.close(); } };
  return { home, workspace, agent, store, config, requests, close };
}

async function resumed(environment: Awaited<ReturnType<typeof setup>>) {
  const store = await SessionStore.resume(environment.store.info.id, environment.home);
  const agent = new AgentRuntime({ store, config: environment.config, providerFactory: createProvider, executor: createToolExecutor() });
  cleanup.push(() => agent.close());
  return { agent, store };
}

describe('real runtime + provider HTTP + tools + persistence integration', () => {
  for (const protocol of ['openai-responses', 'openai-chat', 'anthropic'] as const) {
    it(`${protocol}: approved file mutation traverses the real HTTP/tool loop and resumes without replay`, async () => {
      const environment = await setup(protocol, [{ id: 'write-1', name: 'write_file', arguments: { path: '结果.txt', content: '真实工具执行完成\n' } }]);
      let approvals = 0;
      environment.agent.subscribe(snapshot => { if (snapshot.approval) { approvals++; environment.agent.approve(true); } });
      await environment.agent.send('创建结果文件，然后报告完成。');
      expect(environment.agent.getSnapshot().status).toBe('idle'); expect(approvals).toBe(1);
      expect(await readFile(join(environment.workspace, '结果.txt'), 'utf8')).toBe('真实工具执行完成\n');
      expect(environment.requests).toHaveLength(2);
      expect(environment.requests[0]!.url).toBe(protocol === 'openai-responses' ? '/v1/responses' : protocol === 'openai-chat' ? '/v1/chat/completions' : '/v1/messages');
      const followup = JSON.stringify(environment.requests[1]!.body); expect(followup).toContain('write-1');
      if (protocol === 'openai-responses') { expect(environment.requests[0]!.body.store).toBe(false); expect(followup).toContain('function_call_output'); }
      else expect(followup).toContain(protocol === 'anthropic' ? 'tool_result' : 'tool_call_id');
      const persisted = environment.store.latestState(); expect(persisted?.messages.some(message => message.role === 'tool' && message.toolCallId === 'write-1')).toBe(true);
      expect(await readFile(join(environment.store.dir, 'events.jsonl'), 'utf8')).not.toContain('integration-only-fake-key');
      environment.agent.setPermission('full'); await environment.close();
      const restored = await resumed(environment); expect(restored.agent.getSnapshot().permission).toBe('ask'); expect(restored.agent.getSnapshot().restored).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 50)); expect(environment.requests).toHaveLength(2);
      expect(restored.store.latestState()?.messages.some(message => message.role === 'tool' && message.toolCallId === 'write-1')).toBe(true);
    });
  }

  it('Responses invokes the real bundled Bash under approval and persists the actual command result', async () => {
    const available = await inspectBash(); expect(available.available, available.error).toBe(true);
    const environment = await setup('openai-responses', [{ id: 'bash-1', name: 'bash', arguments: { command: "printf 'actual-bash-result' > shell-result.txt; printf 'command-finished'" } }]);
    environment.agent.subscribe(snapshot => { if (snapshot.approval) environment.agent.approve(true); });
    await environment.agent.send('执行本地命令并检查结果。');
    expect(environment.agent.getSnapshot().status).toBe('idle'); expect(await readFile(join(environment.workspace, 'shell-result.txt'), 'utf8')).toBe('actual-bash-result');
    const tool = environment.store.latestState()?.messages.find(message => message.toolCallId === 'bash-1'); expect(tool?.content).toContain('command-finished'); expect(tool?.content).toContain('[exit 0]');
    await environment.close(); const restored = await resumed(environment); expect(restored.agent.getSnapshot().entries.find(entry => entry.toolName === 'bash')?.status).toBe('完成');
    expect(environment.requests).toHaveLength(2);
  });

  it('synchronous cancellation from the approval subscriber resolves the pending gate and resumes without mutation or request replay', async () => {
    const environment = await setup('openai-chat', [{ id: 'cancel-write', name: 'write_file', arguments: { path: 'must-not-exist', content: 'bad' } }]);
    let cancelled = false; environment.agent.subscribe(snapshot => { if (snapshot.approval && !cancelled) { cancelled = true; environment.agent.cancel(); } });
    await environment.agent.send('取消等待批准的操作。'); expect(cancelled).toBe(true); expect(environment.agent.getSnapshot().status).toBe('cancelled');
    await expect(readFile(join(environment.workspace, 'must-not-exist'))).rejects.toThrow(); expect(environment.requests).toHaveLength(1);
    expect(environment.store.latestState()?.messages.find(message => message.toolCallId === 'cancel-write')?.content).toContain('取消');
    expect(environment.agent.getSnapshot().entries.find(entry => entry.toolCall?.id === 'cancel-write')?.status).toBe('已取消');
    await environment.close(); const restored = await resumed(environment); expect(restored.agent.getSnapshot().permission).toBe('ask'); expect(restored.agent.getSnapshot().status).toBe('idle');
    await new Promise(resolve => setTimeout(resolve, 50)); expect(environment.requests).toHaveLength(1); await expect(readFile(join(environment.workspace, 'must-not-exist'))).rejects.toThrow();
  });

  it('downgrading full to ask between tools immediately requires approval for the next tool', async () => {
    const environment = await setup('anthropic', [
      { id: 'first-write', name: 'write_file', arguments: { path: 'first', content: 'first' } },
      { id: 'second-write', name: 'write_file', arguments: { path: 'second', content: 'second' } },
    ]);
    environment.agent.setPermission('full'); let downgraded = false; const approvals: string[] = [];
    environment.agent.subscribe(snapshot => {
      if (!downgraded && snapshot.entries.some(entry => entry.toolCall?.id === 'first-write' && entry.status === '完成')) { downgraded = true; environment.agent.setPermission('ask'); }
      if (snapshot.approval) { approvals.push(snapshot.approval.id); environment.agent.approve(false); }
    });
    await environment.agent.send('依次创建两个文件。'); expect(downgraded).toBe(true); expect(approvals).toEqual(['second-write']);
    expect(await readFile(join(environment.workspace, 'first'), 'utf8')).toBe('first'); await expect(readFile(join(environment.workspace, 'second'))).rejects.toThrow();
    expect(environment.agent.getSnapshot().entries.find(entry => entry.toolCall?.id === 'second-write')?.status).toBe('已拒绝'); expect(environment.agent.getSnapshot().status).toBe('idle');
  });

  it('cancel after a completed mutation preserves that mutation and the aborted response on resume', async () => {
    const environment = await setup('openai-responses', [{ id: 'completed-write', name: 'write_file', arguments: { path: 'keep', content: 'committed-local-effect' } }], { holdSecondRequest: true });
    environment.agent.subscribe(snapshot => { if (snapshot.approval) environment.agent.approve(true); });
    const pending = environment.agent.send('先创建文件再等待结果。');
    for (let i = 0; i < 100 && environment.requests.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(environment.requests).toHaveLength(2); environment.agent.cancel(); await pending;
    expect(environment.agent.getSnapshot().status).toBe('cancelled'); expect(await readFile(join(environment.workspace, 'keep'), 'utf8')).toBe('committed-local-effect');
    await environment.close(); const restored = await resumed(environment);
    expect(restored.agent.getSnapshot().entries.find(entry => entry.toolCall?.id === 'completed-write')?.status).toBe('完成'); expect(environment.requests).toHaveLength(2);
  });
});
