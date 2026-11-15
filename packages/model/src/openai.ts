import { ToolCallSchema, type JsonObject, type ModelEvent, type ModelRequest, type ModelUsage, type ToolCall } from '@elvion/kernel';
import { z } from 'zod';
import { parseObject, protocolError, sse } from './stream.js';

const token = z.number().int().nonnegative().nullish();
const ChatChunkSchema = z.object({
  error: z.unknown().optional(),
  choices: z.array(z.object({
    index: z.number().int().nonnegative(),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
      })).optional(),
    }),
    finish_reason: z.string().nullable(),
  })),
  usage: z.object({ prompt_tokens: token, completion_tokens: token, total_tokens: token }).nullish(),
});

export function chatRequest(request: ModelRequest): JsonObject {
  return {
    model: request.model, stream: true, stream_options: { include_usage: true },
    messages: request.messages.map((message) => ({
      role: message.role, content: message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) } : {}),
    })),
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : { tool_choice: 'none' }),
    ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
  };
}

export async function* parseChat(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: ModelUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
  let finish: 'stop' | 'length' | 'tool_calls' | undefined;
  for await (const event of sse(body, signal)) {
    if (event.data === '[DONE]') {
      if (!finish || (finish === 'tool_calls') !== (calls.size > 0)) throw protocolError();
      const complete = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ToolCallSchema.parse({ ...call, arguments: parseObject(call.arguments) }));
      if (new Set(complete.map((call) => call.id)).size !== complete.length) throw protocolError();
      for (const call of complete) yield { type: 'tool_call', call };
      yield { type: 'usage', usage };
      yield { type: 'done', finishReason: finish };
      return;
    }
    const raw = parseObject(event.data);
    if (raw.error) throw protocolError('The model provider reported an error');
    const chunk = ChatChunkSchema.parse(raw);
    if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? null, outputTokens: chunk.usage.completion_tokens ?? null, totalTokens: chunk.usage.total_tokens ?? null };
    for (const choice of chunk.choices) {
      if (choice.index !== 0 || finish) throw protocolError();
      if (choice.delta.content) yield { type: 'text_delta', text: choice.delta.content };
      for (const part of choice.delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        if (part.id) { if (call.id && call.id !== part.id) throw protocolError(); call.id = part.id; }
        call.name += part.function?.name ?? '';
        call.arguments += part.function?.arguments ?? '';
        calls.set(part.index, call);
      }
      if (choice.finish_reason !== null) {
        if (!['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw protocolError('The provider did not complete a supported response');
        finish = choice.finish_reason as 'stop' | 'length' | 'tool_calls';
      }
    }
  }
  throw protocolError();
}

export function responsesRequest(request: ModelRequest): JsonObject {
  const input: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId as string, output: message.content });
    } else {
      if (message.content || !message.toolCalls?.length) input.push({ role: message.role, content: message.content });
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return {
    model: request.model, stream: true, store: false, input,
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}),
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
  };
}

const FunctionItemSchema = z.object({ type: z.literal('function_call'), id: z.string().optional(), call_id: z.string(), name: z.string(), arguments: z.string() });
const ResponseEventSchema = z.object({ type: z.string() }).passthrough();
const CompletedSchema = z.object({
  response: z.object({
    status: z.literal('completed'),
    output: z.array(z.object({ type: z.string() }).passthrough()),
    usage: z.object({ input_tokens: token, output_tokens: token, total_tokens: token }).nullish(),
  }),
});

export async function* parseResponses(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const partial = new Map<string, { name: string; id: string; arguments: string }>();
  const argumentDone = new Set<string>();
  for await (const event of sse(body, signal)) {
    const value = ResponseEventSchema.parse(parseObject(event.data));
    if (event.event !== 'message' && event.event !== value.type) throw protocolError();
    switch (value.type) {
      case 'response.output_text.delta': {
        const parsed = z.object({ delta: z.string() }).parse(value);
        yield { type: 'text_delta', text: parsed.delta };
        break;
      }
      case 'response.output_item.added': {
        const parsed = z.object({ item: z.object({ type: z.string() }).passthrough() }).parse(value);
        if (parsed.item.type === 'function_call') {
          const item = FunctionItemSchema.extend({ id: z.string() }).parse(parsed.item);
          if (partial.has(item.id)) throw protocolError();
          partial.set(item.id, { id: item.call_id, name: item.name, arguments: item.arguments });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const parsed = z.object({ item_id: z.string(), delta: z.string() }).parse(value);
        const call = partial.get(parsed.item_id);
        if (!call || argumentDone.has(parsed.item_id)) throw protocolError();
        call.arguments += parsed.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const parsed = z.object({ item_id: z.string(), arguments: z.string() }).parse(value);
        const call = partial.get(parsed.item_id);
        if (!call || argumentDone.has(parsed.item_id) || call.arguments !== parsed.arguments) throw protocolError();
        parseObject(parsed.arguments);
        argumentDone.add(parsed.item_id);
        break;
      }
      case 'response.completed': {
        const completed = CompletedSchema.parse(value);
        const calls: ToolCall[] = [];
        for (const item of completed.response.output) {
          if (item.type !== 'function_call') continue;
          const parsed = FunctionItemSchema.parse(item);
          const tracked = parsed.id ? partial.get(parsed.id) : undefined;
          if (tracked && (tracked.id !== parsed.call_id || tracked.name !== parsed.name || tracked.arguments !== parsed.arguments)) throw protocolError();
          calls.push(ToolCallSchema.parse({ id: parsed.call_id, name: parsed.name, arguments: parseObject(parsed.arguments) }));
        }
        if (new Set(calls.map((call) => call.id)).size !== calls.length || [...partial.values()].some((item) => !calls.some((call) => call.id === item.id))) throw protocolError();
        for (const call of calls) yield { type: 'tool_call', call };
        const usage = completed.response.usage;
        yield { type: 'usage', usage: { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, totalTokens: usage?.total_tokens ?? null } };
        yield { type: 'done', finishReason: calls.length ? 'tool_calls' : 'stop' };
        return;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        throw protocolError('The model response failed or was incomplete');
    }
  }
  throw protocolError();
}
