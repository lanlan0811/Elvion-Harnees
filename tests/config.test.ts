import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseTokenCount, resolveApiKey, saveConfig } from '../core/config.js';
const dirs: string[] = [];
async function temp() { const d = await mkdtemp(join(tmpdir(), 'elvion-config-')); dirs.push(d); return d; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const profile = { id: 'test', name: '自定义模型', protocol: 'openai-chat' as const, baseUrl: 'https://example.com/v1', model: 'custom', contextWindow: 1_000_000, maxOutputTokens: 384_000 };
describe('模型配置', () => {
  it('接受十进制容量，不把所有模型锁死在预设', () => { expect(parseTokenCount('1m')).toBe(1_000_000); expect(parseTokenCount('512k')).toBe(512_000); expect(parseTokenCount('384K')).toBe(384_000); expect(parseTokenCount('1.5k')).toBe(1500); for (const bad of ['-1', '0', '1kb', 'Infinity', '0.0001k']) expect(() => parseTokenCount(bad)).toThrow(); });
  it('保存与读取本地密钥和模型容量', async () => { const home = await temp(); await saveConfig({ version: 1, profiles: [{ ...profile, apiKey: 'file-key' }], activeProfileId: 'test' }, home); const config = await loadConfig(home); expect(resolveApiKey(config.profiles[0]!)).toBe('file-key'); expect(await readFile(join(home, 'config.json'), 'utf8')).toContain('384000'); });
  it.each(['ELVION_TEST_KEY', 'legacy-invalid-name'])('忽略旧配置字段 %s，不再覆盖本地密钥且保存时清除', async apiKeyEnv => {
    const home = await temp(); vi.stubEnv(apiKeyEnv, 'env-key');
    const legacy = { ...profile, apiKey: 'file-key', apiKeyEnv };
    expect(resolveApiKey(legacy)).toBe('file-key');
    await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, profiles: [legacy], activeProfileId: 'test' }));
    const config = await loadConfig(home); expect(config.profiles[0]).not.toHaveProperty('apiKeyEnv'); expect(resolveApiKey(config.profiles[0]!)).toBe('file-key');
    await saveConfig(config, home); expect(await readFile(join(home, 'config.json'), 'utf8')).not.toContain('apiKeyEnv');
  });
  it('仅有旧环境变量名时要求补填密钥，不把环境变量值写入文件', async () => {
    const home = await temp(); vi.stubEnv('ELVION_TEST_KEY', 'env-key');
    const legacy = { ...profile, apiKeyEnv: 'ELVION_TEST_KEY' };
    expect(() => resolveApiKey(legacy)).toThrow('未配置 API Key');
    await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, profiles: [legacy] }));
    const config = await loadConfig(home); expect(() => resolveApiKey(config.profiles[0]!)).toThrow('未配置 API Key');
    await saveConfig(config, home); expect(await readFile(join(home, 'config.json'), 'utf8')).not.toContain('env-key');
  });
  it.each(['', '   '])('拒绝旧配置中的空白本地密钥：%j', apiKey => { expect(() => resolveApiKey({ ...profile, apiKey })).toThrow('未配置 API Key'); });
  it('拒绝无效地址、额度与活动模型引用', async () => { const home = await temp(); await expect(saveConfig({ version: 1, profiles: [{ ...profile, baseUrl: 'http://remote.example' }] }, home)).rejects.toThrow(); await expect(saveConfig({ version: 1, profiles: [{ ...profile, maxOutputTokens: 2_000_000 }] }, home)).rejects.toThrow(); await expect(saveConfig({ version: 1, profiles: [profile], activeProfileId: 'missing' }, home)).rejects.toThrow(); });
  it('缺失配置返回空表，损坏配置不静默覆盖', async () => { const home = await temp(); expect((await loadConfig(home)).profiles).toEqual([]); await writeFile(join(home, 'config.json'), '{bad'); await expect(loadConfig(home)).rejects.toThrow('配置读取失败'); });
});
