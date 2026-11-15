import { ToolCallSchema, type JsonObject, type JsonValue, type ModelEvent, type ModelRequest, type ModelUsage, type ToolCall } from '@elvion/kernel';
import { z } from 'zod';
import { parseObject, protocolError, sse } from './stream.js';

export function anthropicRequest(request: ModelRequest): JsonObject {
  const messages: { role: string; content: JsonObject[] }[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: JsonObject[] = [];
    if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.toolCallId as string, content: message.content });
    else {
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  return {
    model: request.model, stream: true, max_tokens: request.maxOutputTokens ?? 4096,
    ...(system ? { system } : {}),
    messages: messages as JsonValue[],
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
  };
}

const token = z.number().int().nonnegative().nullish();
export async function* parseAnthropic(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const blocks = new Map<number, { type: string; closed: boolean; id?: string; name?: string; json: string; initial?: JsonObject }>();
  let started = false;
  let finish: 'stop' | 'length' | 'tool_calls' | undefined;
  const usage: ModelUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
  for await (const event of sse(body, signal)) {
    const value = z.object({ type: z.string() }).passthrough().parse(parseObject(event.data));
    if (event.event !== 'message' && event.event !== value.type) throw protocolError();
    switch (value.type) {
      case 'message_start': {
        if (started) throw protocolError();
        const start = z.object({ message: z.object({ usage: z.object({ input_tokens: token, output_tokens: token }).optional() }) }).parse(value);
        started = true;
        usage.inputTokens = start.message.usage?.input_tokens ?? null;
        // message_start commonly reports zero before generation; only final cumulative usage is authoritative.
        usage.outputTokens = null;
        break;
      }
      case 'content_block_start': {
        const parsed = z.object({ index: z.number().int().nonnegative(), content_block: z.object({ type: z.string() }).passthrough() }).parse(value);
        if (!started || finish || blocks.has(parsed.index)) throw protocolError();
        const block = parsed.content_block;
        if (block.type === 'tool_use') {
          const tool = z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.json()) }).parse(block);
          blocks.set(parsed.index, { type: block.type, closed: false, id: tool.id, name: tool.name, json: '', initial: tool.input as JsonObject });
        } else {
          blocks.set(parsed.index, { type: block.type, closed: false, json: '' });
          if (block.type === 'text') {
            const text = z.string().parse(block.text);
            if (text) yield { type: 'text_delta', text };
          }
        }
        break;
      }
      case 'content_block_delta': {
        const parsed = z.object({ index: z.number().int().nonnegative(), delta: z.object({ type: z.string() }).passthrough() }).parse(value);
        const block = blocks.get(parsed.index);
        if (!block || block.closed || finish) throw protocolError();
        if (parsed.delta.type === 'text_delta') {
          if (block.type !== 'text') throw protocolError();
          yield { type: 'text_delta', text: z.string().parse(parsed.delta.text) };
        } else if (parsed.delta.type === 'input_json_delta') {
          if (block.type !== 'tool_use') throw protocolError();
          block.json += z.string().parse(parsed.delta.partial_json);
        }
        break;
      }
      case 'content_block_stop': {
        const parsed = z.object({ index: z.number().int().nonnegative() }).parse(value);
        const block = blocks.get(parsed.index);
        if (!block || block.closed) throw protocolError();
        block.closed = true;
        break;
      }
      case 'message_delta': {
        const parsed = z.object({ delta: z.object({ stop_reason: z.string().nullable() }), usage: z.object({ output_tokens: token }).optional() }).parse(value);
        if (!started || finish || [...blocks.values()].some((block) => !block.closed)) throw protocolError();
        if (parsed.delta.stop_reason === 'tool_use') finish = 'tool_calls';
        else if (parsed.delta.stop_reason === 'max_tokens') finish = 'length';
        else if (['end_turn', 'stop_sequence'].includes(parsed.delta.stop_reason ?? '')) finish = 'stop';
        else throw protocolError('The provider returned an unsupported stopping reason');
        usage.outputTokens = parsed.usage?.output_tokens ?? usage.outputTokens;
        break;
      }
      case 'message_stop': {
        if (!started || !finish || [...blocks.values()].some((block) => !block.closed)) throw protocolError();
        const calls: ToolCall[] = [];
        for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
          if (block.type !== 'tool_use') continue;
          calls.push(ToolCallSchema.parse({ id: block.id, name: block.name, arguments: block.json ? parseObject(block.json) : block.initial }));
        }
        if ((finish === 'tool_calls') !== (calls.length > 0) || new Set(calls.map((call) => call.id)).size !== calls.length) throw protocolError();
        for (const call of calls) yield { type: 'tool_call', call };
        if (usage.inputTokens !== null && usage.outputTokens !== null) usage.totalTokens = usage.inputTokens + usage.outputTokens;
        yield { type: 'usage', usage };
        yield { type: 'done', finishReason: finish };
        return;
      }
      case 'error': throw protocolError('The model provider reported an error');
    }
  }
  throw protocolError();
}
