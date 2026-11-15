import { ElvionError, type EventEnvelope } from '@elvion/kernel';
import type { ProviderConfig } from '@elvion/model';
import type { HealthStatus } from './ui/types.js';

export interface TuiDiagnostics { storage: HealthStatus; runtimes: Record<string, HealthStatus>; phase: 'idle' | 'model' | 'tool' | 'verification' }
export function providerIdentity(provider: ProviderConfig): string { return JSON.stringify([provider.id, provider.protocol, provider.baseUrl, provider.model, provider.apiKeyEnv ?? null, provider.capabilities.tools, provider.timeoutMs ?? null]); }
export function initialDiagnostics(storageReady: boolean): TuiDiagnostics { return { storage: storageReady ? { state: 'ok', label: 'Idle' } : { state: 'error', label: 'Storage unavailable' }, runtimes: {}, phase: 'idle' }; }
export function observeStorage(state: TuiDiagnostics, okay: boolean): TuiDiagnostics { return { ...state, storage: okay ? { state: 'ok', label: 'Idle' } : { state: 'error', label: 'Storage unavailable' } }; }
export function recordProviderProbe(state: TuiDiagnostics, provider: ProviderConfig, okay: boolean): TuiDiagnostics { return { ...state, runtimes: { ...state.runtimes, [providerIdentity(provider)]: okay ? { state: 'ok', label: 'Connected' } : { state: 'error', label: 'Provider unavailable' } } }; }
export function runtimeHealth(state: TuiDiagnostics, provider: ProviderConfig | undefined, environment: NodeJS.ProcessEnv = process.env): HealthStatus {
  if (!provider || (provider.apiKeyEnv && !environment[provider.apiKeyEnv])) return { state: 'warning', label: 'Provider setup required' };
  return state.runtimes[providerIdentity(provider)] ?? { state: 'ok', label: 'Configured (not probed)' };
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function failure(state: TuiDiagnostics, provider: ProviderConfig | undefined, code: unknown): TuiDiagnostics {
  if (code === 'storage_error') return observeStorage(state, false);
  if (provider && (code === 'model_error' || (state.phase === 'model' && (code === 'timeout' || code === 'configuration_error')))) return recordProviderProbe(state, provider, false);
  return state;
}
export function projectDiagnosticFailure(state: TuiDiagnostics, provider: ProviderConfig | undefined, error: unknown): TuiDiagnostics { return error instanceof ElvionError ? failure(state, provider, error.code) : state; }
/** Execution events have already been persisted. Their order identifies the active operation; a Shell timeout is not a model outage. */
export function projectDiagnostics(state: TuiDiagnostics, provider: ProviderConfig | undefined, event: EventEnvelope): TuiDiagnostics {
  let next = observeStorage(state, true); const payload = object(event.payload);
  if (event.type === 'model.requested' || (event.type === 'task.planning' && payload['source'] === 'model')) next = { ...next, phase: 'model' };
  if (event.type === 'tool.started') next = { ...next, phase: 'tool' };
  if (event.type === 'verification.started') next = { ...next, phase: 'verification' };
  if (['model.text', 'agent.message', 'agent.delivery', 'agent.context_compacted'].includes(event.type) || (event.type === 'task.planned' && next.phase === 'model')) {
    if (provider) next = recordProviderProbe(next, provider, true);
  }
  if (event.type.startsWith('execution.')) next = failure(next, provider, object(payload['error'])['code']);
  if (event.type === 'tool.finished') next = { ...next, phase: 'idle' };
  if (event.type === 'task.planned' || event.type === 'agent.message' || event.type === 'agent.delivery' || event.type === 'verification.finished' || (event.type.startsWith('execution.') && !['execution.started', 'execution.resumed', 'execution.retry'].includes(event.type))) next = { ...next, phase: 'idle' };
  return next;
}
