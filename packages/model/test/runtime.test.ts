import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeError, type ModelEvent, type ModelMessage, type ToolCall } from '@elvion/kernel';
import { ProviderRuntime, probeProvider, type ProviderConfig } from '../src/index.js';

const servers: Server[] = [];
const signal = () => new AbortController().signal;
const sse = (value: unknown, event?: string) => (event ? 'event: ' + event + '\n' : '') + 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const event = (type: string, fields: Record<string, unknown> = {}) => sse({ type, ...fields }, type);
const callA: ToolCall = { id: 'call-a', name: 'read_file', arguments: { path: '中文.ts' } };
const callB: ToolCall = { id: 'call-b', name: 'glob', arguments: { pattern: '*.ts' } };
const messages: ModelMessage[] = [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Read files.' }];
type Protocol = ProviderConfig['protocol'];

async function fixture(protocol: Protocol, responses: { body: string; status?: number; hang?: boolean }[]) {
  const requests: { path: string; body: Record<string, unknown>; auth: string | undefined; key: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url ?? '', body: JSON.parse(body) as Record<string, unknown>, auth: request.headers.authorization, key: request.headers['x-api-key'] as string | undefined });
    const item = responses[requests.length - 1] ?? responses.at(-1);
    if (!item) throw new Error('Missing fixture response');
    response.writeHead(item.status ?? 200, { 'content-type': protocol === 'ollama-chat' ? 'application/x-ndjson' : 'text/event-stream' });
    const bytes = Buffer.from(item.body);
    for (let index = 0; index < bytes.length; index += 17) {
      if (response.destroyed) return;
      response.write(bytes.subarray(index, index + 17));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!item.hang) response.end();
  });
  servers.push(server);
  let address: ReturnType<Server['address']> = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    server.listen(20_000 + Math.floor(Math.random() * 30_000), '127.0.0.1');
    try {
      await once(server, 'listening');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw error;
    }
    address = server.address();
    break;
  }
  if (!address || typeof address === 'string' || address.port < 11_000) throw new Error('Missing safe fixture address');
  const config: ProviderConfig = { id: 'test', name: 'Test', model: 'test-model', protocol, baseUrl: 'http://127.0.0.1:' + address.port, apiKeyEnv: 'TEST_MODEL_KEY', capabilities: { tools: true } };
  return { config, requests, runtime: new ProviderRuntime(config, { env: { TEST_MODEL_KEY: 'test-credential' } }) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});

async function collect(runtime: ProviderRuntime, input = messages, options = { signal: signal() }): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const item of runtime.stream({ model: 'test-model', messages: input }, options)) events.push(item);
  return events;
}

function textBody(protocol: Protocol, text = '完成中文', usage = true): string {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + (usage ? sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) : '') + sse('[DONE]');
  if (protocol === 'openai-responses') return event('response.output_text.delta', { delta: text }) + event('response.completed', { response: { status: 'completed', output: [], ...(usage ? { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } : {}) } });
  if (protocol === 'anthropic-messages') return event('message_start', { message: { ...(usage ? { usage: { input_tokens: 3, output_tokens: 0 } } : {}) } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn' }, ...(usage ? { usage: { output_tokens: 2 } } : {}) }) + event('message_stop');
  return JSON.stringify({ message: { content: text }, done: false }) + '\n' + JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', ...(usage ? { prompt_eval_count: 3, eval_count: 2 } : {}) }) + '\n';
}

function toolsBody(protocol: Protocol): string {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callA.id, type: 'function', function: { name: callA.name, arguments: '{"path":' } }, { index: 1, id: callB.id, type: 'function', function: { name: callB.name, arguments: '{"pattern":' } }] }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"*.ts"}' } }, { index: 0, function: { arguments: '"中文.ts"}' } }] }, finish_reason: 'tool_calls' }] }) + sse('[DONE]');
  if (protocol === 'openai-responses') {
    const items = [callA, callB].map((call, index) => ({ type: 'function_call', id: 'item-' + index, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }));
    return items.map((item) => event('response.output_item.added', { item: { ...item, arguments: '' } }) + event('response.function_call_arguments.delta', { item_id: item.id, delta: item.arguments }) + event('response.function_call_arguments.done', { item_id: item.id, arguments: item.arguments })).join('') + event('response.completed', { response: { status: 'completed', output: items } });
  }
  if (protocol === 'anthropic-messages') return event('message_start', { message: {} }) + [callA, callB].map((call, index) => event('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }) + event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } }) + event('content_block_stop', { index })).join('') + event('message_delta', { delta: { stop_reason: 'tool_use' } }) + event('message_stop');
  return JSON.stringify({ done: false, message: { content: '', tool_calls: [callA, callB].map((call) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } }) + '\n' + JSON.stringify({ done: true, done_reason: 'stop' }) + '\n';
}

function interruptedToolBody(protocol: Protocol, insideArguments: boolean): string {
  if (insideArguments) {
    if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callA.id, type: 'function', function: { name: callA.name, arguments: '{"path":' } }] }, finish_reason: null }] });
    if (protocol === 'openai-responses') return event('response.output_item.added', { item: { type: 'function_call', id: 'item-a', call_id: callA.id, name: callA.name, arguments: '' } }) + event('response.function_call_arguments.delta', { item_id: 'item-a', delta: '{"path":' });
    if (protocol === 'anthropic-messages') return event('message_start', { message: {} }) + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: callA.id, name: callA.name, input: {} } }) + event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
    return '{"done":false,"message":{"content":"","tool_calls":[{"id":"call-a","function":{"name":"read_file","arguments":{"path":';
  }
  const body = toolsBody(protocol);
  if (protocol === 'openai-chat') return body.slice(0, body.lastIndexOf('data: [DONE]'));
  if (protocol === 'openai-responses') return body.slice(0, body.lastIndexOf('event: response.completed'));
  if (protocol === 'anthropic-messages') return body.slice(0, body.lastIndexOf('event: message_stop'));
  return body.slice(0, body.indexOf('\n') + 1);
}

describe.each<Protocol>(['openai-chat', 'openai-responses', 'anthropic-messages', 'ollama-chat'])('%s real HTTP streaming', (protocol) => {
  it('decodes fragmented UTF-8, terminal events and actual usage', async () => {
    const { runtime, requests } = await fixture(protocol, [{ body: textBody(protocol) }]);
    const events = await collect(runtime);
    expect(events.filter((item) => item.type === 'text_delta').map((item) => item.text).join('')).toBe('完成中文');
    expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(requests[0]?.path).toBe({ 'openai-chat': '/chat/completions', 'openai-responses': '/responses', 'anthropic-messages': '/messages', 'ollama-chat': '/api/chat' }[protocol]);
    if (protocol === 'anthropic-messages') expect(requests[0]?.key).toBe('test-credential');
    else expect(requests[0]?.auth).toBe('Bearer test-credential');
    if (protocol === 'openai-chat') expect(requests[0]?.body['tool_choice']).toBe('none');
  });

  it('retains unknown usage instead of inventing zero', async () => {
    const { runtime } = await fixture(protocol, [{ body: textBody(protocol, 'ok', false) }]);
    expect((await collect(runtime)).at(-2)).toEqual({ type: 'usage', usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
  });

  it('keeps per-request usage independent when a later round omits all token counts', async () => {
    const { runtime, requests } = await fixture(protocol, [{ body: textBody(protocol, 'first') }, { body: textBody(protocol, 'second', false) }, { body: textBody(protocol, 'third') }]);
    const known = { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    expect((await collect(runtime)).at(-2)).toEqual(known);
    expect((await collect(runtime)).at(-2)).toEqual({ type: 'usage', usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
    expect((await collect(runtime)).at(-2)).toEqual(known);
    expect(requests).toHaveLength(3);
  });

  it('validates multi-tool arguments and maps correlated results on the following turn', async () => {
    const { runtime, requests } = await fixture(protocol, [{ body: toolsBody(protocol) }, { body: textBody(protocol, 'verified') }]);
    const first = await collect(runtime);
    const calls = first.filter((item) => item.type === 'tool_call').map((item) => item.call);
    expect(calls).toEqual([callA, callB]);
    expect(first.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
    expect(first.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
    const next: ModelMessage[] = [...messages, { role: 'assistant', content: '', toolCalls: calls }, ...calls.map((call): ModelMessage => ({ role: 'tool', content: JSON.stringify({ result: call.id }), toolCallId: call.id }))];
    const following = await collect(runtime, next);
    expect(following.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(following.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    const second = requests[1]?.body;
    expect(second).toBeDefined();
    const serialized = JSON.stringify(second);
    if (protocol !== 'ollama-chat') { expect(serialized).toContain('call-a'); expect(serialized).toContain('call-b'); }
    if (protocol === 'openai-responses') expect(second).toMatchObject({ input: expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: callA.id })]) });
    if (protocol === 'anthropic-messages') expect(second).toMatchObject({ system: 'Be helpful.', messages: expect.arrayContaining([expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: callA.id })]) })]) });
    if (protocol === 'ollama-chat') expect(second).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_name: 'read_file' })]) });
    for (const call of calls) {
      if (protocol === 'openai-chat') expect(second).toMatchObject({ messages: expect.arrayContaining([{ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result: call.id }) }]) });
      if (protocol === 'openai-responses') expect(second).toMatchObject({ input: expect.arrayContaining([{ type: 'function_call_output', call_id: call.id, output: JSON.stringify({ result: call.id }) }]) });
      if (protocol === 'anthropic-messages') expect(second).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.arrayContaining([{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ result: call.id }) }]) })]) });
      if (protocol === 'ollama-chat') expect(second).toMatchObject({ messages: expect.arrayContaining([{ role: 'tool', tool_name: call.name, content: JSON.stringify({ result: call.id }) }]) });
    }
  });

  it.each([true, false])('never releases tool calls when the connection ends inside arguments=%s before the terminal event', async (insideArguments) => {
    const { runtime, requests } = await fixture(protocol, [{ body: interruptedToolBody(protocol, insideArguments) }]);
    const emitted: ModelEvent[] = [];
    await expect((async () => { for await (const item of runtime.stream({ model: 'test-model', messages }, { signal: signal() })) emitted.push(item); })()).rejects.toMatchObject({ code: 'model_error' });
    expect(requests).toHaveLength(1);
    expect(emitted.filter(item => item.type === 'tool_call')).toEqual([]);
    expect(emitted.filter(item => item.type === 'done')).toEqual([]);
  });

  it('rejects a stream that ends without its protocol terminal event', async () => {
    const full = textBody(protocol);
    const body = protocol === 'ollama-chat' ? full.slice(0, full.indexOf('\n') + 1) : full.slice(0, full.lastIndexOf('event:') > 0 ? full.lastIndexOf('event:') : full.lastIndexOf('data:'));
    const { runtime } = await fixture(protocol, [{ body }]);
    await expect(collect(runtime)).rejects.toMatchObject({ code: 'model_error' });
  });

  it('reports HTTP failure without exposing credential or provider error text', async () => {
    const { runtime } = await fixture(protocol, [{ body: 'test-credential private-provider-response', status: 429 }]);
    let error: unknown;
    try { await collect(runtime); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'model_error', retryable: true });
    expect(JSON.stringify(serializeError(error))).not.toContain('test-credential');
    expect(JSON.stringify(serializeError(error))).not.toContain('private-provider-response');
  });

  it('aborts a pending network stream locally on user cancellation', async () => {
    const { runtime } = await fixture(protocol, [{ body: protocol === 'ollama-chat' ? '\n' : ': ping\n\n', hang: true }]);
    const controller = new AbortController();
    const pending = collect(runtime, messages, { signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('times out a stalled stream with a distinct timeout code', async () => {
    const { config } = await fixture(protocol, [{ body: protocol === 'ollama-chat' ? '\n' : ': ping\n\n', hang: true }]);
    const runtime = new ProviderRuntime(config, { timeoutMs: 40, env: { TEST_MODEL_KEY: 'test-credential' } });
    await expect(collect(runtime)).rejects.toMatchObject({ code: 'timeout', retryable: false });
  });

  it('rejects provider error events without yielding a terminal success', async () => {
    const body = protocol === 'ollama-chat'
      ? JSON.stringify({ error: 'private-provider-error' }) + String.fromCharCode(10)
      : protocol === 'openai-chat' ? sse({ error: { message: 'private-provider-error' } })
      : event(protocol === 'openai-responses' ? 'error' : 'error', { error: { message: 'private-provider-error' } });
    const { runtime } = await fixture(protocol, [{ body }]);
    await expect(collect(runtime)).rejects.toMatchObject({ code: 'model_error', retryable: false });
  });

  it('rejects malformed tool names and duplicate call IDs before emitting any calls', async () => {
    for (const body of [toolsBody(protocol).replaceAll('read_file', 'bad tool'), toolsBody(protocol).replaceAll('call-b', 'call-a')]) {
      const { runtime } = await fixture(protocol, [{ body }]);
      const emitted: ModelEvent[] = [];
      await expect((async () => { for await (const item of runtime.stream({ model: 'test-model', messages }, { signal: signal() })) emitted.push(item); })()).rejects.toMatchObject({ code: 'model_error' });
      expect(emitted.filter((item) => item.type === 'tool_call')).toHaveLength(0);
    }
  });
});

describe('provider safety and capabilities', () => {
  it('prevents silent model substitution', async () => {
    const { runtime, requests } = await fixture('openai-chat', [{ body: textBody('openai-chat') }]);
    await expect(runtime.stream({ model: 'other-model', messages }, { signal: signal() })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'configuration_error' });
    expect(requests).toHaveLength(0);
  });

  it('does not fetch with missing credentials or unsupported tools', async () => {
    const { config, requests } = await fixture('openai-chat', [{ body: textBody('openai-chat') }]);
    await expect(collect(new ProviderRuntime(config, { env: {} }))).rejects.toMatchObject({ code: 'configuration_error' });
    const runtime = new ProviderRuntime({ ...config, capabilities: { tools: false } }, { env: { TEST_MODEL_KEY: 'test' } });
    await expect(runtime.stream({ model: config.model, messages, tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }] }, { signal: signal() })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'configuration_error' });
    expect(requests).toHaveLength(0);
  });

  it('uses the actual stream for connectivity probes', async () => {
    const { config } = await fixture('openai-chat', [{ body: textBody('openai-chat', 'OK') }]);
    await expect(probeProvider(config, { env: { TEST_MODEL_KEY: 'test' } })).resolves.toEqual({ text: 'OK', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  });

  it('does not emit incomplete tool JSON', async () => {
    const body = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'bash', arguments: '{"command":' } }] }, finish_reason: 'tool_calls' }] }) + sse('[DONE]');
    const { runtime } = await fixture('openai-chat', [{ body }]);
    const events: ModelEvent[] = [];
    await expect((async () => { for await (const item of runtime.stream({ model: 'test-model', messages }, { signal: signal() })) events.push(item); })()).rejects.toMatchObject({ code: 'model_error' });
    expect(events.filter((item) => item.type === 'tool_call')).toHaveLength(0);
  });
});
