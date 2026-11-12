import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createProvider } from '../providers/index.js';
import { cleanError, decodeSSE, endpoint } from '../providers/common.js';
import { anthropicMessages, chatMessages, responseInput } from '../providers/serialize.js';
import type { Message, ModelProfile, Protocol, ProviderEvent, ProviderRequest } from '../core/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const frame = (value: unknown): string => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
async function server(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>): Promise<string> {
  const instance = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    try { await handler(req, res, JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
    catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  cleanups.push(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器启动失败');
  return 'http://127.0.0.1:' + address.port;
}
function request(protocol: Protocol, baseUrl: string, messages: Message[] = [{ role: 'user', content: '你好' }]): ProviderRequest {
  const profile: ModelProfile = { id: protocol, name: '测试', protocol, baseUrl, model: 'test-model', contextWindow: 100_000, maxOutputTokens: 2000 };
  return { profile, apiKey: 'sk-provider-secret', messages, tools: [{ name: 'read_file', description: '读取', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], maxOutputTokens: 1000, signal: new AbortController().signal };
}
async function collect(req: ProviderRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of createProvider(req.profile).stream(req)) events.push(event);
  return events;
}
const responseCall = { type: 'function_call', id: 'fc_1', call_id: 'call1', name: 'read_file', arguments: '{"path":"中文.ts"}', status: 'completed' };
const chatTool = { index: 0, id: 'call1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } };

describe('Provider URL 与流协议', () => {
  it('拼接 API 路径且拒绝外网 HTTP、URL 凭据和查询参数', () => {
    expect(endpoint('https://example.com', 'responses')).toBe('https://example.com/v1/responses');
    expect(endpoint('https://example.com/v1/', 'responses')).toBe('https://example.com/v1/responses');
    expect(endpoint('https://example.com/custom/v2', 'messages')).toBe('https://example.com/custom/v2/messages');
    expect(endpoint('https://example.com/v1/responses', 'responses')).toBe('https://example.com/v1/responses');
    for (const invalid of ['http://example.com/v1', 'https://key@example.com/v1', 'https://example.com/?key=x', 'file:///tmp/api']) expect(() => endpoint(invalid, 'responses')).toThrow();
  });

  it('解码任意 UTF-8 分块、CRLF、注释和多行 SSE 数据', async () => {
    const encoded = new TextEncoder().encode(': ping\r\nevent: message\r\ndata: 中文\r\ndata: 第二行\r\n\r\n');
    const source = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const output = [];
    for await (const value of decodeSSE(source)) output.push(value);
    expect(output).toEqual([{ event: 'message', data: '中文\n第二行' }]);
  });

  it('不转发带密钥的重定向请求', async () => {
    let redirected = 0;
    const destination = await server((_req, res) => { redirected++; res.end(); });
    const origin = await server((_req, res) => { res.writeHead(307, { Location: destination + '/v1/responses' }); res.end(); });
    await expect(collect(request('openai-responses', origin))).rejects.toThrow();
    expect(redirected).toBe(0);
  });

  it('HTTP 与流内错误脱敏且不重试', async () => {
    let attempts = 0;
    const base = await server((_req, res) => { attempts++; res.writeHead(401); res.end('bad sk-provider-secret \u001b[31mkey'); });
    const error = await collect(request('openai-chat', base)).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain('sk-provider-secret');
    expect((error as Error).message).not.toContain('\u001b');
    expect(attempts).toBe(1);
    expect(cleanError('sk-\u001b[31mprovider-secret', 'sk-provider-secret')).not.toContain('sk-provider-secret');
  });

  it('外部 AbortSignal 中断等待中的数据流', async () => {
    const base = await server((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); });
    const req = request('openai-responses', base);
    const controller = new AbortController();
    req.signal = controller.signal;
    const result = collect(req);
    setTimeout(() => controller.abort(), 50);
    await expect(result).rejects.toThrow('取消');
  });

  it('拒绝非 SSE、畸形 JSON、无效 UTF-8 与无效 token 预算', async () => {
    const bodies = [
      { type: 'application/json', data: Buffer.from('{}') },
      { type: 'text/event-stream', data: Buffer.from('data: {broken}\n\n') },
      { type: 'text/event-stream', data: Buffer.from([100, 97, 116, 97, 58, 32, 0xc3, 0x28, 10, 10]) },
    ];
    for (const body of bodies) {
      const base = await server((_req, res) => { res.writeHead(200, { 'Content-Type': body.type }); res.end(body.data); });
      await expect(collect(request('openai-responses', base))).rejects.toThrow();
    }
    const invalid = request('openai-chat', 'http://127.0.0.1:1');
    invalid.maxOutputTokens = 0;
    await expect(collect(invalid)).rejects.toThrow('预算');
  });
});

describe('OpenAI Responses', () => {
  it('发送无状态请求，按最终完整结果提交工具并保留私有输出', async () => {
    let captured: any;
    let url: string | undefined;
    const base = await server((req, res, body) => {
      captured = body; url = req.url;
      expect(req.headers.authorization).toBe('Bearer sk-provider-secret');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame({ type: 'response.output_text.delta', delta: '你好' }));
      res.write(frame({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' }));
      res.write(frame({ type: 'response.output_item.done', output_index: 1, item: responseCall }));
      res.end(frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'rs', encrypted_content: 'private' }, responseCall], usage: { input_tokens: 10, output_tokens: 4 } } }));
    });
    const events = await collect(request('openai-responses', base));
    expect(url).toBe('/v1/responses');
    expect(captured.store).toBe(false);
    expect(captured.previous_response_id).toBeUndefined();
    expect(captured.max_output_tokens).toBe(1000);
    expect(captured.tools[0].type).toBe('function');
    expect(events.find(e => e.type === 'text')).toEqual({ type: 'text', text: '你好' });
    expect(events.find(e => e.type === 'tool')).toEqual({ type: 'tool', call: { id: 'call1', name: 'read_file', arguments: { path: '中文.ts' } } });
    expect(events.find(e => e.type === 'provider-data')).toEqual({ type: 'provider-data', items: [{ type: 'reasoning', id: 'rs', encrypted_content: 'private' }, responseCall] });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'tool_calls' });
  });

  it('断流和不完整响应不发出工具执行事件', async () => {
    for (const ending of ['', frame({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })]) {
      const base = await server((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame({ type: 'response.output_item.done', output_index: 0, item: responseCall }) + ending); });
      const received: ProviderEvent[] = [];
      await expect((async () => { for await (const event of createProvider(request('openai-responses', base).profile).stream(request('openai-responses', base))) received.push(event); })()).rejects.toThrow();
      expect(received.some(e => e.type === 'tool')).toBe(false);
    }
  });

  it('无效 JSON 对象工具参数导致失败', async () => {
    const base = await server((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame({ type: 'response.completed', response: { status: 'completed', output: [{ ...responseCall, arguments: '[]' }] } })); });
    await expect(collect(request('openai-responses', base))).rejects.toThrow('工具参数');
  });

  it('完整事件无需服务器断开即可结束，且重复 ID 不执行', async () => {
    const base = await server((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame({ type: 'response.completed', response: { status: 'completed', output: [] } }));
    });
    expect((await collect(request('openai-responses', base))).at(-1)).toEqual({ type: 'done', reason: 'stop' });
    const duplicate = await server((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame({ type: 'response.completed', response: { status: 'completed', output: [responseCall, responseCall] } }));
    });
    await expect(collect(request('openai-responses', duplicate))).rejects.toThrow('重复工具调用');
  });
});

describe('OpenAI Chat Completions', () => {
  it('组装多个分片工具参数，保留 reasoning_content 和 token 用量', async () => {
    let captured: any;
    const base = await server((_req, res, body) => {
      captured = body;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame({ choices: [{ index: 0, delta: { content: '读取文件', reasoning_content: 'private', tool_calls: [chatTool, { index: 1, id: 'call2', function: { name: 'read_file', arguments: '{"path":"b"}' } }] }, finish_reason: null }] }));
      res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: null }] }));
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      res.write(frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
      res.end(frame('[DONE]'));
    });
    const req = request('openai-chat', base);
    req.profile.outputParameter = 'max_tokens';
    const events = await collect(req);
    expect(captured.max_tokens).toBe(1000);
    expect(captured.max_completion_tokens).toBeUndefined();
    expect(events.filter(e => e.type === 'tool')).toHaveLength(2);
    expect(events.find(e => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } });
    expect(events.find(e => e.type === 'provider-data')).toEqual({ type: 'provider-data', items: [{ reasoning_content: 'private' }] });
  });

  it('缺失 DONE、工具参数截断、工具 ID 重复不会返回成功', async () => {
    const cases = [
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      frame({ choices: [{ delta: { content: '未完成' }, finish_reason: 'length' }] }) + frame('[DONE]'),
      frame({ choices: [{ delta: { tool_calls: [chatTool] }, finish_reason: 'length' }] }) + frame('[DONE]'),
      frame({ choices: [{ delta: { tool_calls: [{ ...chatTool, function: { name: 'read_file', arguments: '{}' } }, { index: 1, id: 'call1', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + frame('[DONE]'),
    ];
    for (const content of cases) {
      const base = await server((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(content); });
      await expect(collect(request('openai-chat', base))).rejects.toThrow();
    }
  });
});

describe('Anthropic Messages', () => {
  it('解析工具与签名分片，保留原始块，正确发送 API 头', async () => {
    let captured: any;
    const base = await server((req, res, body) => {
      captured = body;
      expect(req.url).toBe('/v1/messages');
      expect(req.headers['x-api-key']).toBe('sk-provider-secret');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call1', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"中文"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ];
      res.end(events.map(frame).join(''));
    });
    const events = await collect(request('anthropic', base));
    expect(captured.max_tokens).toBe(1000);
    expect(captured.tools[0].input_schema.type).toBe('object');
    expect(events.find(e => e.type === 'tool')).toEqual({ type: 'tool', call: { id: 'call1', name: 'read_file', arguments: { path: '中文' } } });
    expect(events.find(e => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 13, outputTokens: 9, cachedTokens: 3 } });
    expect(events.find(e => e.type === 'provider-data')).toMatchObject({ items: [{ type: 'thinking', thinking: 'private', signature: 'signed' }, { type: 'tool_use', input: { path: '中文' } }] });
  });

  it('未闭合内容块和 error 事件不能触发工具', async () => {
    for (const ending of [frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + frame({ type: 'message_stop' }), frame({ type: 'error', error: { message: 'sk-provider-secret rejected' } })]) {
      const base = await server((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(frame({ type: 'message_start', message: { usage: {} } }) + frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call1', name: 'read_file', input: {} } }) + ending);
      });
      const error = await collect(request('anthropic', base)).catch(e => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('sk-provider-secret');
    }
  });

  it('max_tokens 终止不能宣称回复完整完成', async () => {
    const base = await server((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame({ type: 'message_start', message: { usage: {} } }) + frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) + frame({ type: 'message_stop' }));
    });
    await expect(collect(request('anthropic', base))).rejects.toThrow('未正常结束');
  });
});

describe('会话历史序列化', () => {
  const calls = [{ id: 'call1', name: 'read_file', arguments: { path: 'a' } }, { id: 'call2', name: 'read_file', arguments: { path: 'b' } }];
  const messages: Message[] = [{ role: 'system', content: '系统' }, { role: 'user', content: '读取' }, { role: 'assistant', content: '准备', toolCalls: calls }, { role: 'tool', toolCallId: 'call1', content: 'a' }, { role: 'tool', toolCallId: 'call2', content: 'b' }];

  it('Anthropic 工具结果紧随调用且合并到同一 user 内容块', () => {
    const converted = anthropicMessages(request('anthropic', 'https://api.example.com', messages));
    expect(converted.system).toBe('系统');
    expect(converted.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(converted.messages[2]?.content).toHaveLength(2);
    expect(converted.messages[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call1', content: 'a' });
  });

  it('Responses 重播本供应商原始输出，切换供应商仅重建通用历史', () => {
    const req = request('openai-responses', 'https://api.example.com', structuredClone(messages));
    req.messages[2]!.providerData = { profileId: req.profile.id, protocol: 'openai-responses', items: [{ type: 'reasoning', encrypted_content: 'private' }, responseCall] };
    expect(responseInput(req).some(item => item.type === 'reasoning')).toBe(true);
    req.profile.id = 'different';
    const switched = responseInput(req);
    expect(switched.some(item => item.type === 'reasoning')).toBe(false);
    expect(switched.filter(item => item.type === 'function_call')).toHaveLength(2);
    expect(switched.at(-1)).toEqual({ type: 'function_call_output', call_id: 'call2', output: 'b' });
  });

  it('Chat 不把其他供应商私有 reasoning 移植到新模型', () => {
    const req = request('openai-chat', 'https://api.example.com', structuredClone(messages));
    req.messages[2]!.providerData = { profileId: 'old', protocol: 'openai-chat', items: [{ reasoning_content: 'private' }] };
    expect(chatMessages(req)[2]?.reasoning_content).toBeUndefined();
    req.messages[2]!.providerData!.profileId = req.profile.id;
    expect(chatMessages(req)[2]?.reasoning_content).toBe('private');
  });

  it('未闭合工具历史在发起 HTTP 前失败', async () => {
    const req = request('openai-chat', 'http://127.0.0.1:1', messages.slice(0, -1));
    await expect(collect(req)).rejects.toThrow('未闭合工具调用');
  });
});
