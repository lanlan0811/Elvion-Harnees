import { ElvionError, JsonObjectSchema, throwIfAborted, type JsonObject } from '@elvion/kernel';

const MAX_LINE_BYTES = 1_048_576;
const MAX_STREAM_BYTES = 33_554_432;

export function protocolError(message = 'The model returned an invalid or interrupted stream'): ElvionError {
  return new ElvionError('model_error', message);
}

export function parseObject(text: string): JsonObject {
  try {
    return JsonObjectSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new ElvionError('model_error', 'The model returned invalid JSON', { cause: error });
  }
}

export async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw protocolError('Model stream exceeded its size limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw protocolError('Model stream line exceeded its size limit');
        yield line;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw protocolError('Model stream line exceeded its size limit');
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  let event = 'message';
  let data: string[] = [];
  let size = 0;
  for await (const line of lines(body, signal)) {
    if (!line) {
      if (data.length) yield { event, data: data.join('\n') };
      event = 'message';
      data = [];
      size = 0;
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      size += Buffer.byteLength(value);
      if (size > MAX_LINE_BYTES) throw protocolError('Model event exceeded its size limit');
      data.push(value);
    }
  }
  if (data.length) throw protocolError('Model stream ended before its event delimiter');
}
