import type { ModelProfile, ProviderAdapter, ProviderEvent, ProviderRequest, ToolCall, Usage } from '../core/types.js';
import { cleanError, eventObject, object, streamEvents, usage, validateCall, MAX_EVENT_BYTES, type JsonObject } from './common.js';
import { anthropicMessages, chatMessages, responseInput, validateHistory } from './serialize.js';

function providerFailure(value: JsonObject): Error {
  return new Error(typeof value.message === 'string' ? value.message : 'Provider 返回错误事件');
}

function checkBuffer(value: string): string {
  if (value.length > MAX_EVENT_BYTES) throw new Error('Provider 流式字段超过大小上限');
  return value;
}

async function* responses(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
  const tools = request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
  const payload: JsonObject = {
    model: request.profile.model, input: responseInput(request), stream: true, store: false,
    max_output_tokens: request.maxOutputTokens, include: ['reasoning.encrypted_content'],
    ...(tools.length ? { tools } : {}),
  };
  const rawItems = new Map<number, JsonObject>();
  let complete = false;
  let terminal: JsonObject | undefined;
  let seenText = false;
  for await (const frame of streamEvents(request, 'responses', payload, { Authorization: 'Bearer ' + request.apiKey })) {
    if (frame.data === '[DONE]') continue;
    const event = eventObject(frame.data);
    const type = event.type ?? frame.event;
    if (type === 'error') throw providerFailure(event);
    if (type === 'response.failed' || type === 'response.incomplete') throw providerFailure(event.response?.error ?? { message: 'Provider 响应未完整完成：' + (event.response?.incomplete_details?.reason ?? type) });
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (typeof event.delta !== 'string') throw new Error('Provider 文本增量无效');
      seenText = true;
      yield { type: 'text', text: event.delta };
    }
    if (type === 'response.output_item.done') rawItems.set(event.output_index, object(event.item, '输出项目'));
    if (type === 'response.completed') {
      if (complete) throw new Error('Provider 重复返回完成事件');
      terminal = object(event.response, '完成响应');
      if (terminal.status && terminal.status !== 'completed') throw new Error('Provider 完成事件状态无效');
      complete = true;
      // A complete terminal event closes the stream. Do not wait for a server to close its socket.
      break;
    }
  }
  if (!complete || !terminal) throw new Error('Provider 数据流中断，未收到完成事件');
  const items: JsonObject[] = Array.isArray(terminal.output) ? terminal.output.map((item: unknown) => object(item, '输出项目')) : [...rawItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call') {
      const call = validateCall(item.call_id, item.name, item.arguments);
      if (ids.has(call.id)) throw new Error('Provider 返回重复工具调用 ID');
      ids.add(call.id); calls.push(call);
    }
    if (!seenText && item.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content.type === 'output_text' && typeof content.text === 'string') yield { type: 'text', text: content.text };
        if (content.type === 'refusal' && typeof content.refusal === 'string') yield { type: 'text', text: content.refusal };
      }
    }
  }
  if (terminal.usage) yield { type: 'usage', usage: usage(terminal.usage.input_tokens, terminal.usage.output_tokens, terminal.usage.input_tokens_details?.cached_tokens) };
  yield { type: 'provider-data', items };
  for (const call of calls) yield { type: 'tool', call };
  yield { type: 'done', reason: calls.length ? 'tool_calls' : 'stop' };
}

async function* chat(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
  const tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const payload: JsonObject = {
    model: request.profile.model, messages: chatMessages(request), stream: true,
    stream_options: { include_usage: true },
    [request.profile.outputParameter ?? 'max_completion_tokens']: request.maxOutputTokens,
    ...(tools.length ? { tools } : {}),
  };
  const partial = new Map<number, { id: string; name: string; args: string }>();
  let complete = false;
  let finish: string | null = null;
  let reasoning = '';
  let finalUsage: Usage | undefined;
  for await (const frame of streamEvents(request, 'chat/completions', payload, { Authorization: 'Bearer ' + request.apiKey })) {
    if (frame.data === '[DONE]') { complete = true; break; }
    const event = eventObject(frame.data);
    if (event.error) throw providerFailure(object(event.error));
    if (event.usage) finalUsage = usage(event.usage.prompt_tokens, event.usage.completion_tokens, event.usage.prompt_tokens_details?.cached_tokens);
    if (!Array.isArray(event.choices)) throw new Error('Provider Chat 响应缺少 choices');
    if (event.choices.length > 1) throw new Error('Provider 返回多个候选回复，无法安全选择工具');
    const choice = event.choices[0];
    if (!choice) continue;
    if (choice.index !== undefined && choice.index !== 0) throw new Error('Provider 候选回复编号无效');
    if (finish !== null && choice.delta && Object.keys(choice.delta).length) throw new Error('Provider 完成后继续发送内容');
    if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
    if (typeof delta.reasoning_content === 'string') reasoning = checkBuffer(reasoning + delta.reasoning_content);
    if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw new Error('Provider 工具调用增量无效');
    for (const tool of delta.tool_calls ?? []) {
      if (!Number.isSafeInteger(tool.index) || tool.index < 0 || tool.index > 255) throw new Error('Provider 工具调用索引无效');
      const state = partial.get(tool.index) ?? { id: '', name: '', args: '' };
      if (tool.id !== undefined) {
        if (typeof tool.id !== 'string' || (state.id && state.id !== tool.id)) throw new Error('Provider 工具调用 ID 发生变化');
        state.id = tool.id;
      }
      if (tool.function?.name !== undefined) state.name = checkBuffer(state.name + tool.function.name);
      if (tool.function?.arguments !== undefined) {
        if (typeof tool.function.arguments !== 'string') throw new Error('Provider 工具参数增量无效');
        state.args = checkBuffer(state.args + tool.function.arguments);
      }
      partial.set(tool.index, state);
    }
  }
  if (!complete || finish === null) throw new Error('Provider 数据流中断，未收到完整结束标记');
  if (partial.size && finish !== 'tool_calls') throw new Error('Provider 工具调用未完整结束：' + finish);
  if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(finish)) throw new Error('Provider 返回未知结束原因');
  if (finish === 'content_filter') throw new Error('Provider 内容过滤阻止了完整回复');
  if (finish === 'length') throw new Error('Provider 回复达到输出额度，内容未完整结束');
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const [, value] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    const call = validateCall(value.id, value.name, value.args);
    if (ids.has(call.id)) throw new Error('Provider 返回重复工具调用 ID');
    ids.add(call.id); calls.push(call);
  }
  if (finish === 'tool_calls' && !calls.length) throw new Error('Provider 声称调用工具但未提供调用');
  if (finalUsage) yield { type: 'usage', usage: finalUsage };
  if (reasoning) yield { type: 'provider-data', items: [{ reasoning_content: reasoning }] };
  for (const call of calls) yield { type: 'tool', call };
  yield { type: 'done', reason: finish };
}

async function* anthropic(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
  const converted = anthropicMessages(request);
  const tools = request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  const payload: JsonObject = {
    model: request.profile.model, ...converted, max_tokens: request.maxOutputTokens, stream: true,
    ...(tools.length ? { tools } : {}),
  };
  const blocks = new Map<number, { block: JsonObject; arguments: string; closed: boolean }>();
  let complete = false;
  let started = false;
  let reason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for await (const frame of streamEvents(request, 'messages', payload, { 'x-api-key': request.apiKey, 'anthropic-version': '2023-06-01' })) {
    const event = eventObject(frame.data);
    const type = event.type ?? frame.event;
    if (type === 'error') throw providerFailure(object(event.error));
    if (type === 'message_start') {
      if (started) throw new Error('Provider 重复发送 message_start');
      started = true;
      const initialUsage = event.message?.usage ?? {};
      cachedTokens = Number(initialUsage.cache_read_input_tokens) || 0;
      inputTokens = (Number(initialUsage.input_tokens) || 0) + (Number(initialUsage.cache_creation_input_tokens) || 0) + cachedTokens;
      outputTokens = Number(initialUsage.output_tokens) || 0;
    }
    if (type === 'content_block_start') {
      if (!started || !Number.isSafeInteger(event.index) || event.index < 0 || event.index > 255 || blocks.has(event.index)) throw new Error('Provider 内容块开始状态无效');
      const block = { ...object(event.content_block, '内容块') };
      blocks.set(event.index, { block, arguments: '', closed: false });
      if (block.type === 'text' && typeof block.text === 'string' && block.text) yield { type: 'text', text: block.text };
    }
    if (type === 'content_block_delta') {
      const state = blocks.get(event.index);
      if (!state || state.closed) throw new Error('Provider 内容增量缺少未闭合内容块');
      const delta = object(event.delta, '内容增量');
      if (delta.type === 'text_delta') {
        if (state.block.type !== 'text' || typeof delta.text !== 'string') throw new Error('Provider 文本增量类型不匹配');
        state.block.text = checkBuffer((state.block.text ?? '') + delta.text);
        yield { type: 'text', text: delta.text };
      } else if (delta.type === 'input_json_delta') {
        if (state.block.type !== 'tool_use' || typeof delta.partial_json !== 'string') throw new Error('Provider 工具参数增量类型不匹配');
        state.arguments = checkBuffer(state.arguments + delta.partial_json);
      } else if (delta.type === 'thinking_delta') {
        if (typeof delta.thinking !== 'string') throw new Error('Provider 私有状态增量无效');
        state.block.thinking = checkBuffer((state.block.thinking ?? '') + delta.thinking);
      } else if (delta.type === 'signature_delta') {
        if (typeof delta.signature !== 'string') throw new Error('Provider 签名增量无效');
        state.block.signature = checkBuffer((state.block.signature ?? '') + delta.signature);
      }
    }
    if (type === 'content_block_stop') {
      const state = blocks.get(event.index);
      if (!state || state.closed) throw new Error('Provider 内容块结束状态无效');
      if (state.block.type === 'tool_use') state.block.input = validateCall(state.block.id, state.block.name, state.arguments || state.block.input).arguments;
      state.closed = true;
    }
    if (type === 'message_delta') {
      if (typeof event.delta?.stop_reason === 'string') reason = event.delta.stop_reason;
      if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
    }
    if (type === 'message_stop') { complete = true; break; }
  }
  if (!started || !complete || !reason || [...blocks.values()].some(value => !value.closed)) throw new Error('Provider 数据流中断，消息或内容块未完整结束');
  if (!['end_turn', 'tool_use', 'stop_sequence', 'refusal'].includes(reason)) throw new Error('Provider 回复未正常结束：' + reason);
  const items = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, state]) => state.block);
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const block of items) if (block.type === 'tool_use') {
    const call = validateCall(block.id, block.name, block.input);
    if (ids.has(call.id)) throw new Error('Provider 返回重复工具调用 ID');
    ids.add(call.id); calls.push(call);
  }
  if (calls.length && reason !== 'tool_use') throw new Error('Provider 工具调用未完整结束：' + reason);
  if (reason === 'tool_use' && !calls.length) throw new Error('Provider 声称调用工具但未提供调用');
  yield { type: 'usage', usage: usage(inputTokens, outputTokens, cachedTokens) };
  yield { type: 'provider-data', items };
  for (const call of calls) yield { type: 'tool', call };
  yield { type: 'done', reason };
}

export function createProvider(profile: ModelProfile): ProviderAdapter {
  const adapter = profile.protocol === 'openai-responses' ? responses : profile.protocol === 'openai-chat' ? chat : profile.protocol === 'anthropic' ? anthropic : undefined;
  if (!adapter) throw new Error('不支持的 Provider 协议');
  return {
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
      if (request.profile.protocol !== profile.protocol || request.profile.id !== profile.id) throw new Error('Provider 实例与请求配置不匹配');
      try {
        validateHistory(request.messages);
        yield* adapter(request);
      } catch (error) { throw new Error(cleanError(error, request.apiKey)); }
    },
  };
}
