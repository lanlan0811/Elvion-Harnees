import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProviderConfigs, ProviderConfigSchema, saveProviderConfigs, type ProviderConfig } from '../src/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const config: ProviderConfig = { id: 'custom', name: 'Custom Qwen-compatible endpoint', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', model: 'configured-model', apiKeyEnv: 'MODEL_API_KEY', capabilities: { tools: true } };

describe('provider configuration', () => {
  it('round-trips environment references and atomically replaces saved data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvion-model-'));
    directories.push(directory);
    const path = join(directory, 'providers.json');
    expect(await loadProviderConfigs(path)).toEqual([]);
    await saveProviderConfigs(path, [config]);
    expect(await loadProviderConfigs(path)).toEqual([config]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, providers: [config] });
    await saveProviderConfigs(path, [{ ...config, model: 'second-model' }]);
    expect((await loadProviderConfigs(path))[0]?.model).toBe('second-model');
  });

  it('rejects secrets, executable plugins and credentials embedded in URLs', () => {
    expect(ProviderConfigSchema.safeParse({ ...config, apiKey: 'private-value' }).success).toBe(false);
    expect(ProviderConfigSchema.safeParse({ ...config, script: 'plugin.js' }).success).toBe(false);
    expect(ProviderConfigSchema.safeParse({ ...config, baseUrl: 'https://user:password@example.invalid' }).success).toBe(false);
    expect(ProviderConfigSchema.safeParse({ ...config, baseUrl: 'https://example.invalid?key=private' }).success).toBe(false);
    expect(ProviderConfigSchema.safeParse({ ...config, baseUrl: 'file:///tmp/model' }).success).toBe(false);
    expect(ProviderConfigSchema.safeParse({ ...config, apiKeyEnv: 'secret-value with spaces' }).success).toBe(false);
  });

  it('rejects corrupt or future schemas and duplicate IDs without overwriting data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvion-model-'));
    directories.push(directory);
    const path = join(directory, 'providers.json');
    await writeFile(path, JSON.stringify({ version: 2, providers: [config] }));
    await expect(loadProviderConfigs(path)).rejects.toMatchObject({ code: 'configuration_error' });
    await expect(saveProviderConfigs(path, [config, config])).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2);
    await writeFile(path, '{');
    await expect(loadProviderConfigs(path)).rejects.toMatchObject({ code: 'configuration_error' });
  });
});
