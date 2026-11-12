import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseTokenCount, resolveApiKey, saveConfig } from '../core/config.js';
const dirs: string[] = [];
async function temp() { const d = await mkdtemp(join(tmpdir(), 'elvion-config-')); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const profile = { id: 'test', name: '自定义模型', protocol: 'openai-chat' as const, baseUrl: 'https://example.com/v1', model: 'custom', contextWindow: 1_000_000, maxOutputTokens: 384_000 };
describe('模型配置', () => {
  it('接受十进制容量，不把所有模型锁死在预设', () => { expect(parseTokenCount('1m')).toBe(1_000_000); expect(parseTokenCount('512k')).toBe(512_000); expect(parseTokenCount('384K')).toBe(384_000); expect(parseTokenCount('1.5k')).toBe(1500); for (const bad of ['-1', '0', '1kb', 'Infinity', '0.0001k']) expect(() => parseTokenCount(bad)).toThrow(); });
  it('保存与读取，环境变量覆盖文件密钥', async () => { const home = await temp(); await saveConfig({ version: 1, profiles: [{ ...profile, apiKey: 'file-key', apiKeyEnv: 'ELVION_TEST_KEY' }], activeProfileId: 'test' }, home); const config = await loadConfig(home); process.env.ELVION_TEST_KEY = 'env-key'; expect(resolveApiKey(config.profiles[0]!)).toBe('env-key'); delete process.env.ELVION_TEST_KEY; expect(resolveApiKey(config.profiles[0]!)).toBe('file-key'); expect(await readFile(join(home, 'config.json'), 'utf8')).toContain('384000'); });
  it('拒绝无效地址、额度与活动模型引用', async () => { const home = await temp(); await expect(saveConfig({ version: 1, profiles: [{ ...profile, baseUrl: 'http://remote.example' }] }, home)).rejects.toThrow(); await expect(saveConfig({ version: 1, profiles: [{ ...profile, maxOutputTokens: 2_000_000 }] }, home)).rejects.toThrow(); await expect(saveConfig({ version: 1, profiles: [profile], activeProfileId: 'missing' }, home)).rejects.toThrow(); });
  it('缺失配置返回空表，损坏配置不静默覆盖', async () => { const home = await temp(); expect((await loadConfig(home)).profiles).toEqual([]); await writeFile(join(home, 'config.json'), '{bad'); await expect(loadConfig(home)).rejects.toThrow('配置读取失败'); });
});
