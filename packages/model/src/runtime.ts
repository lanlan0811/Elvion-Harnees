import {
  CancellationScope, ElvionError, ModelEventSchema, ModelRequestSchema, throwIfAborted,
  type ModelEvent, type ModelRequest, type ModelRuntime, type ModelUsage,
} from '@elvion/kernel';
import { ZodError } from 'zod';
import { anthropicRequest, parseAnthropic } from './anthropic.js';
import { ProviderConfigSchema, type ProviderConfig } from './config.js';
import { ollamaRequest, parseOllama } from './ollama.js';
import { chatRequest, parseChat, parseResponses, responsesRequest } from './openai.js';

export interface ProviderRuntimeOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}
const protocolImplementations = {
  'openai-chat': { path: 'chat/completions', request: chatRequest, parse: parseChat },
  'openai-responses': { path: 'responses', request: responsesRequest, parse: parseResponses },
  'anthropic-messages': { path: 'messages', request: anthropicRequest, parse: parseAnthropic },
  'ollama-chat': { path: 'api/chat', request: ollamaRequest, parse: parseOllama },
} as const;

/** Four explicit protocols. No provider/model fallback or arbitrary executable plugins. */
export class ProviderRuntime implements ModelRuntime {
  readonly config: Readonly<ProviderConfig>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #env: Record<string, string | undefined>;
  readonly #timeoutMs: number;

  constructor(config: ProviderConfig, options: ProviderRuntimeOptions = {}) {
    const validated = ProviderConfigSchema.parse(config);
    Object.freeze(validated.capabilities);
    this.config = Object.freeze(validated);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    // Validate the same timer constraints without retaining a live timer.
    const scope = new CancellationScope({ timeoutMs: this.#timeoutMs });
    scope.dispose();
  }

  async *stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelEvent> {
    const scope = new CancellationScope({ signal: options.signal, timeoutMs: this.#timeoutMs });
    try {
      throwIfAborted(scope.signal);
      const validated = ModelRequestSchema.parse(request);
      if (validated.model !== this.config.model) throw new ElvionError('configuration_error', 'Requested model does not match the selected provider model');
      if (validated.tools?.length && !this.config.capabilities.tools) throw new ElvionError('configuration_error', 'The selected provider/model does not declare tool support');
      const implementation = protocolImplementations[this.config.protocol];
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: this.config.protocol === 'ollama-chat' ? 'application/x-ndjson' : 'text/event-stream' };
      if (this.config.protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
      if (this.config.apiKeyEnv) {
        const key = this.#env[this.config.apiKeyEnv];
        if (!key || /[\r\n]/.test(key)) throw new ElvionError('configuration_error', 'Provider credential environment variable is missing or invalid');
        if (this.config.protocol === 'anthropic-messages') headers['x-api-key'] = key;
        else headers.authorization = `Bearer ${key}`;
      }
      const base = this.config.baseUrl.replace(/\/+$/, '') + '/';
      const response = await this.#fetch(new URL(implementation.path, base), {
        method: 'POST', headers, body: JSON.stringify(implementation.request(validated)),
        signal: scope.signal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ElvionError('model_error', `Model provider returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500, details: { status: response.status },
        });
      }
      if (!response.body) throw new ElvionError('model_error', 'The model provider returned no stream');
      const contentType = response.headers.get('content-type') ?? '';
      if (this.config.protocol !== 'ollama-chat' && !contentType.includes('text/event-stream')) {
        await response.body.cancel().catch(() => undefined);
        throw new ElvionError('model_error', 'The provider did not return an event stream');
      }
      for await (const event of implementation.parse(response.body, scope.signal)) {
        throwIfAborted(scope.signal);
        const checked = ModelEventSchema.parse(event);
        if (checked.type === 'tool_call' && !this.config.capabilities.tools) {
          throw new ElvionError('model_error', 'The provider returned an undeclared tool call');
        }
        yield checked;
      }
    } catch (error) {
      throwIfAborted(scope.signal);
      if (error instanceof ElvionError) throw error;
      if (error instanceof ZodError) throw new ElvionError('model_error', 'Model request or response failed schema validation', { cause: error });
      throw new ElvionError('model_error', 'The model connection failed', { cause: error, retryable: true });
    } finally {
      scope.dispose();
    }
  }
}

export async function probeProvider(config: ProviderConfig, options: ProviderRuntimeOptions & { signal?: AbortSignal } = {}): Promise<{ text: string; usage: ModelUsage }> {
  const runtime = new ProviderRuntime(config, options);
  const signal = options.signal ?? new AbortController().signal;
  let text = '';
  let usage: ModelUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
  for await (const event of runtime.stream({ model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], maxOutputTokens: 16 }, { signal })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'usage') usage = event.usage;
    if (event.type === 'tool_call') throw new ElvionError('model_error', 'Provider probe returned an unexpected tool call');
  }
  if (!text) throw new ElvionError('model_error', 'Provider probe returned no text');
  return { text, usage };
}
