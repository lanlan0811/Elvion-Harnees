# Model Runtime

Native `fetch` adapters implement four explicit wire protocols. Qwen and custom providers use a configured protocol, endpoint, model and capability declaration; the runtime never selects a fallback. A Base URL is the API root: OpenAI-compatible services normally end in `/v1`, Anthropic normally ends in `/v1`, and Ollama uses its server root. Protocol paths are appended to that root.

`ProviderRuntime.stream(request, { signal })` yields text deltas, complete validated tool calls, usage and a terminal event. Tool calls are buffered until the protocol confirms completion. Interrupted responses, duplicate call IDs, malformed arguments, unsupported finish reasons and HTTP errors fail explicitly. Unknown usage stays `null`. Responses and Anthropic use their own request/response mappings rather than a changed Chat Completions URL. Local abort stops this client request; it does not guarantee the provider stopped computing.

Configuration storage uses a versioned JSON document and atomic file replacement. It accepts only environment-variable references for credentials. Unknown properties, script plugins, duplicate IDs and embedded URL credentials are rejected. HTTP is available for explicitly configured local endpoints; redirects are rejected to avoid forwarding credentials to another destination. Response bodies and raw causes are excluded from serialized provider errors.

Tests use a real loopback HTTP server and fragmented UTF-8 streams. They cover all four request mappings, tools with multiple calls, result correlation on a later turn, errors, incomplete responses, unknown usage, timeout, cancellation and configuration persistence. These protocol checks are distinct from live account validation. On 2026-11-15, one user-configured OpenAI-compatible endpoint completed a real four-task coding fixture, 51 tool calls and four independent verification passes, ending in execution.completed / exit 0. See docs/acceptance/live-model-2026-11-15.json; other live protocol/provider combinations remain unverified.

Protocol facts were checked against these primary sources on 2026-11-15:

- OpenAI generated Chat Completions types: https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts
- OpenAI generated Responses types: https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts
- Anthropic stream event reference: https://docs.anthropic.com/en/api/messages-streaming
- Ollama Chat reference: https://docs.ollama.com/api/chat

The OpenAI documentation search/page service returned no content in this environment. Official SDK-generated type definitions were read as a schema reference, per the task's explicit fallback; no SDK implementation was copied or added as a runtime dependency.
