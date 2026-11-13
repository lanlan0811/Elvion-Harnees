import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig, ModelProfile } from './types.js';
export const profileSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().min(1).max(100),
  protocol: z.enum(['openai-responses', 'openai-chat', 'anthropic']),
  baseUrl: z.string().url().refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))); }, '地址必须使用 HTTPS 且不包含凭据、查询或片段；仅本机测试允许 HTTP'),
  model: z.string().min(1).max(256), apiKey: z.string().optional(),
  contextWindow: z.number().int().min(1024).max(100_000_000), maxOutputTokens: z.number().int().positive().max(100_000_000),
  outputParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
}).refine(p => p.maxOutputTokens < p.contextWindow, '最大输出必须小于上下文容量');
const configSchema = z.object({ version: z.literal(1), profiles: z.array(profileSchema), activeProfileId: z.string().optional() }).superRefine((c, ctx) => {
  if (new Set(c.profiles.map(p => p.id)).size !== c.profiles.length) ctx.addIssue({ code: 'custom', message: '模型配置 ID 不可重复', path: ['profiles'] });
  if (c.activeProfileId && !c.profiles.some(p => p.id === c.activeProfileId)) ctx.addIssue({ code: 'custom', message: '活动模型不存在', path: ['activeProfileId'] });
});
export function getAppHome(): string { return process.env.ELVION_HOME || join(homedir(), '.elvion'); }
export function parseTokenCount(value: string | number): number {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value <= 0) throw new Error('容量必须为正整数'); return value; }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(value);
  if (!match) throw new Error('容量格式无效，例如 1m、512k、384k');
  const n = Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1000 : 1);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('容量必须换算为正整数 token'); return n;
}
export async function loadConfig(home = getAppHome()): Promise<AppConfig> {
  try { return configSchema.parse(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: [] }; throw new Error('配置读取失败：' + (error instanceof z.ZodError ? error.issues.map(i => i.message).join('；') : 'JSON 无效或无法读取')); }
}
export async function saveConfig(config: AppConfig, home = getAppHome()): Promise<void> {
  const valid = configSchema.parse(config); await mkdir(home, { recursive: true, mode: 0o700 });
  const target = join(home, 'config.json'); const temp = target + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, target); if (process.platform !== 'win32') await chmod(target, 0o600);
}
export function resolveApiKey(profile: ModelProfile): string {
  const key = profile.apiKey; if (!key?.trim()) throw new Error('模型 ' + profile.name + ' 未配置 API Key，请使用 /provider'); return key;
}
