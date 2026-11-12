import type { Message, ProviderRequest } from '../core/types.js';
import { sameProvider, type JsonObject } from './common.js';

export function responseInput(request: ProviderRequest): JsonObject[] {
  const input: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('工具结果缺少调用 ID');
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    } else if (message.role === 'assistant' && sameProvider(request, message) && message.providerData!.items.length) {
      input.push(...message.providerData!.items as JsonObject[]);
    } else {
      if (message.content) input.push({ role: message.role === 'system' ? 'developer' : message.role, content: message.content });
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return input;
}

export function chatMessages(request: ProviderRequest): JsonObject[] {
  return request.messages.map(message => {
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('工具结果缺少调用 ID');
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    const result: JsonObject = { role: message.role, content: message.content || (message.toolCalls?.length ? null : '') };
    if (message.toolCalls?.length) result.tool_calls = message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    // Some compatible models require their private reasoning value on tool continuations.
    if (sameProvider(request, message)) {
      const privateMessage = message.providerData!.items[0] as JsonObject | undefined;
      if (typeof privateMessage?.reasoning_content === 'string') result.reasoning_content = privateMessage.reasoning_content;
    }
    return result;
  });
}

export function anthropicMessages(request: ProviderRequest): { system: string; messages: JsonObject[] } {
  const system: string[] = [];
  const messages: JsonObject[] = [];
  const add = (role: string, content: JsonObject[]): void => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of request.messages) {
    if (message.role === 'system') { if (message.content) system.push(message.content); continue; }
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('工具结果缺少调用 ID');
      add('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]);
      continue;
    }
    if (message.role === 'assistant' && sameProvider(request, message) && message.providerData!.items.length) {
      add('assistant', message.providerData!.items as JsonObject[]); continue;
    }
    const content: JsonObject[] = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    if (content.length) add(message.role, content);
  }
  return { system: system.join('\n\n'), messages };
}

export function validateHistory(messages: Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) throw new Error('会话包含无匹配调用的工具结果');
      continue;
    }
    if (pending.size) throw new Error('会话包含未闭合工具调用');
    for (const call of message.toolCalls ?? []) {
      if (pending.has(call.id)) throw new Error('会话包含重复工具调用 ID');
      pending.add(call.id);
    }
  }
  if (pending.size) throw new Error('会话包含未闭合工具调用');
}
