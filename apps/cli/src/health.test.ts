import { describe, expect, it } from 'vitest';
import { ElvionError, EventSequencer } from '@elvion/kernel';
import type { ProviderConfig } from '@elvion/model';
import { initialDiagnostics, observeStorage, projectDiagnosticFailure, projectDiagnostics, providerIdentity, recordProviderProbe, runtimeHealth } from './health.js';

const provider: ProviderConfig = { id: 'local', name: 'Local fixture', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', capabilities: { tools: true } };
describe('TUI diagnostic projection', () => {
  it('retains a known provider failure across reset and isolates the complete configuration identity', () => {
    let state = recordProviderProbe(initialDiagnostics(true), provider, true);
    state = projectDiagnosticFailure(state, provider, new ElvionError('model_error', 'HTTP 401'));
    expect(runtimeHealth(state, provider)).toEqual({ state: 'error', label: 'Provider unavailable' });
    expect(runtimeHealth(state, { ...provider, model: 'different' }).label).toBe('Configured (not probed)');
    expect(runtimeHealth(state, { ...provider, baseUrl: 'http://127.0.0.1:2/v1' }).label).toBe('Configured (not probed)');
    expect(providerIdentity(provider)).toBe(providerIdentity({ ...provider, name: 'Renamed' }));
    expect(runtimeHealth(state, { ...provider, apiKeyEnv: 'ELVION_MISSING_FIXTURE_CREDENTIAL' }, {}).state).toBe('warning');
    expect(runtimeHealth(recordProviderProbe(state, provider, true), provider).label).toBe('Connected');
  });
  it('marks model timeouts as unavailable but preserves provider status for shell timeouts denial and cancellation', () => {
    const sequence = new EventSequencer({ sessionId: 'diagnostic-timeout' });
    const connected = recordProviderProbe(initialDiagnostics(true), provider, true);
    let model = projectDiagnostics(connected, provider, sequence.next('model.requested', {}));
    model = projectDiagnostics(model, provider, sequence.next('execution.timed_out', { error: { code: 'timeout' } }));
    expect(runtimeHealth(model, provider).state).toBe('error');
    for (const type of ['tool.started', 'verification.started']) {
      let shell = projectDiagnostics(connected, provider, sequence.next(type, {}));
      shell = projectDiagnostics(shell, provider, sequence.next('execution.timed_out', { error: { code: 'timeout' } }));
      expect(runtimeHealth(shell, provider).label).toBe('Connected');
    }
    for (const code of ['cancelled', 'permission_denied']) {
      const state = projectDiagnostics(projectDiagnostics(connected, provider, sequence.next('model.requested', {})), provider, sequence.next('execution.cancelled', { error: { code } }));
      expect(runtimeHealth(state, provider).label).toBe('Connected');
    }
  });
  it('does not accept unknown usage as a successful connection and recovers storage only after a successful operation', () => {
    const sequence = new EventSequencer({ sessionId: 'diagnostic-storage' });
    const failed = projectDiagnosticFailure(initialDiagnostics(true), provider, new ElvionError('storage_error', 'Storage failed'));
    expect(failed.storage.state).toBe('error');
    expect(observeStorage(failed, true).storage.state).toBe('ok');
    const knownModelFailure = recordProviderProbe(failed, provider, false);
    const usage = projectDiagnostics(knownModelFailure, provider, sequence.next('model.usage', { inputTokens: null, outputTokens: null, totalTokens: null }));
    expect(runtimeHealth(usage, provider).state).toBe('error');
    const durable = projectDiagnostics(failed, provider, sequence.next('execution.started', {}));
    expect(durable.storage.state).toBe('ok');
    expect(projectDiagnostics(durable, provider, sequence.next('execution.failed', { error: { code: 'storage_error' } })).storage.state).toBe('error');
  });
});
