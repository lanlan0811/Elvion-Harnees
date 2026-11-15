import { randomUUID } from 'node:crypto';
import { JsonObjectSchema, ToolCallSchema, type JsonObject, type ModelEvent, type ModelRequest, type ToolCall } from '@elvion/kernel';
import { z } from 'zod';
import { lines, parseObject, protocolError } from './stream.js';

export function ollamaRequest(request: ModelRequest): JsonObject {
  const names = new Map(request.messages.flatMap((message) => message.toolCalls?.map((call) => [call.id, call.name] as const) ?? []));
  return {
    model: request.model, stream: true,
    messages: request.messages.map((message) => ({
      role: message.role, content: message.content,
      ...(message.role === 'tool' ? { tool_name: names.get(message.toolCallId as string) ?? '' } : {}),
      ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) } : {}),
    })),
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
    ...(request.maxOutputTokens ? { options: { num_predict: request.maxOutputTokens } } : {}),
  };
}
const ChunkSchema = z.object({
  error: z.string().optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  message: z.object({
    content: z.string(),
    tool_calls: z.array(z.object({ id: z.string().optional(), function: z.object({ name: z.string(), arguments: JsonObjectSchema }) })).optional(),
  }).optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});

export async function* parseOllama(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ModelEvent> {
  const calls: ToolCall[] = [];
  for await (const line of lines(body, signal)) {
    if (!line.trim()) continue;
    const raw = parseObject(line);
    if (raw.error) throw protocolError('The model provider reported an error');
    const chunk = ChunkSchema.parse(raw);
    if (chunk.message?.content) yield { type: 'text_delta', text: chunk.message.content };
    for (const tool of chunk.message?.tool_calls ?? []) {
      calls.push(ToolCallSchema.parse({ id: tool.id ?? `ollama_${randomUUID()}`, name: tool.function.name, arguments: tool.function.arguments }));
    }
    if (chunk.done) {
      if (chunk.done_reason && !['stop', 'length', 'load'].includes(chunk.done_reason)) throw protocolError();
      if (chunk.done_reason === 'length' && calls.length) throw protocolError();
      if (new Set(calls.map((call) => call.id)).size !== calls.length) throw protocolError();
      for (const call of calls) yield { type: 'tool_call', call };
      const inputTokens = chunk.prompt_eval_count ?? null;
      const outputTokens = chunk.eval_count ?? null;
      yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens } };
      yield { type: 'done', finishReason: calls.length ? 'tool_calls' : chunk.done_reason === 'length' ? 'length' : 'stop' };
      return;
    }
  }
  throw protocolError();
}
