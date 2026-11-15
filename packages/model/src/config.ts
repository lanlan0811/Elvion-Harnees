import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ElvionError } from '@elvion/kernel';
import { z } from 'zod';

const BaseUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Provider URL must use HTTP(S) without embedded credentials, query or fragment' });
  }
});
export const ProviderConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128),
  name: z.string().min(1).max(256),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages', 'ollama-chat']),
  baseUrl: BaseUrlSchema,
  model: z.string().min(1).max(256),
  apiKeyEnv: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).optional(),
  capabilities: z.strictObject({ tools: z.boolean() }),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export const ProviderConfigsSchema = z.array(ProviderConfigSchema).superRefine((configs, context) => {
  if (new Set(configs.map((config) => config.id)).size !== configs.length) {
    context.addIssue({ code: 'custom', message: 'Provider IDs must be unique' });
  }
});
const ProviderStoreSchema = z.strictObject({ version: z.literal(1), providers: ProviderConfigsSchema });

export async function loadProviderConfigs(filePath: string): Promise<ProviderConfig[]> {
  let serialized: string;
  try {
    serialized = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ElvionError('configuration_error', 'Cannot read provider configuration', { cause: error });
  }
  try {
    return ProviderStoreSchema.parse(JSON.parse(serialized)).providers;
  } catch (error) {
    throw new ElvionError('configuration_error', 'Invalid or unsupported provider configuration', { cause: error });
  }
}

/** Persist references to environment variables only; unknown credential properties are rejected. */
export async function saveProviderConfigs(filePath: string, configs: readonly ProviderConfig[]): Promise<void> {
  const store = ProviderStoreSchema.parse({ version: 1, providers: configs });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Cleanup is best effort; retain the persistence failure and its original cause.
    }
    throw new ElvionError('configuration_error', 'Cannot save provider configuration', { cause: error });
  }
}
