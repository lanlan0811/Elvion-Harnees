import { stripVTControlCharacters } from 'node:util';
import type { ProviderRequest, ToolCall, Usage } from '../core/types.js';

export const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 120_000;
export type JsonObject = Record<string, any>;

export function object(value: unknown, label = '数据'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider 返回的' + label + '不是对象');
  return value as JsonObject;
}

export function endpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Provider 地址必须使用 HTTPS（本机测试地址除外）');
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider 地址不能包含用户名、密码、查询参数或片段');
  const path = url.pathname.replace(/\/+$/, '');
  const route = '/' + suffix;
  if (path.endsWith(route)) return url.origin + path;
  // Root URLs use the standard API prefix; custom prefixes are preserved.
  return url.origin + (path || '/v1') + route;
}

export function cleanError(value: unknown, secret: string): string {
  let text = value instanceof Error ? value.message : String(value);
  if (secret) text = text.split(secret).join('[已脱敏]');
  text = [...stripVTControlCharacters(text)].filter(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127 || code === 9 || code === 10 || code === 13;
  }).join('');
  if (secret) text = text.split(secret).join('[已脱敏]');
  return text.slice(0, 2000);
}

export function validateCall(id: unknown, name: unknown, input: unknown): ToolCall {
  if (typeof id !== 'string' || !id || id.length > 512 || [...id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new Error('Provider 工具调用缺少有效 id 或名称');
  let args: unknown = input;
  if (typeof input === 'string') {
    if (input.length > MAX_EVENT_BYTES) throw new Error('工具参数超过大小上限');
    try { args = JSON.parse(input); } catch { throw new Error('Provider 工具参数不是完整 JSON'); }
  }
  return { id, name, arguments: object(args, '工具参数') };
}

export function usage(input: unknown, output: unknown, cached?: unknown): Usage {
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return { inputTokens: number(input), outputTokens: number(output), ...(cached === undefined ? {} : { cachedTokens: number(cached) }) };
}

interface SSEEvent { event: string; data: string }
export async function* decodeSSE(body: ReadableStream<Uint8Array>, onChunk: () => void = () => {}): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let eventSize = 0;
  const consumeLine = (line: string): SSEEvent | undefined => {
    if (!line) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      event = ''; data = []; eventSize = 0;
      return result;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') { data.push(value); eventSize += value.length; }
    if (eventSize > MAX_EVENT_BYTES) throw new Error('Provider SSE 事件超过大小上限');
    return;
  };
  try {
    while (true) {
      const result = await reader.read();
      if (!result.done) onChunk();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        const value = consumeLine(line);
        if (value) yield value;
      }
      if (buffer.length > MAX_EVENT_BYTES) throw new Error('Provider SSE 行超过大小上限');
      if (result.done) break;
    }
    if (buffer) { const value = consumeLine(buffer.replace(/\r$/, '')); if (value) yield value; }
    const tail = consumeLine('');
    if (tail) yield tail;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function errorBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  try {
    while (result.length < 8000) {
      const next = await reader.read();
      if (next.done) break;
      result += decoder.decode(next.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return result.slice(0, 8000);
}

export async function* streamEvents(request: ProviderRequest, route: string, payload: JsonObject, headers: Record<string, string>): AsyncGenerator<SSEEvent> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Provider 流式请求超时')), IDLE_TIMEOUT_MS);
    timer.unref?.();
  };
  touch();
  try {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > request.profile.maxOutputTokens) throw new Error('最大输出 token 预算无效');
    const response = await fetch(endpoint(request.profile.baseUrl, route), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('Provider HTTP ' + response.status + ': ' + await errorBody(response));
    if (!response.body) throw new Error('Provider 响应没有数据流');
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw new Error('Provider 未返回 SSE 数据流');
    for await (const value of decodeSSE(response.body, touch)) yield value;
  } catch (error) {
    if (request.signal.aborted) throw new Error('Provider 请求已取消');
    throw new Error(cleanError(controller.signal.aborted ? controller.signal.reason : error, request.apiKey));
  } finally { clearTimeout(timer!); request.signal.removeEventListener('abort', abort); }
}

export function eventObject(data: string): JsonObject {
  try { return object(JSON.parse(data), 'SSE 数据'); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Provider SSE 包含无效 JSON'); throw error; }
}

export function sameProvider(request: ProviderRequest, message: ProviderRequest['messages'][number]): boolean {
  return message.providerData?.profileId === request.profile.id && message.providerData.protocol === request.profile.protocol;
}
