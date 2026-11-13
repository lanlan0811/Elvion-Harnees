import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSystemPrompt } from '../runtime/prompts.js';
import { AgentRuntime } from '../runtime/agent.js';
import { SessionStore } from '../runtime/session.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const promptFiles = ['system.md', 'agent.md', 'tools.md'] as const;
const documents = ['  system first line\n\nSystem final instruction.\n', '\nAgent first line\nAgent final instruction.  ', ' Tools first line\n\nTools final instruction.\n'];
const roots: string[] = [];
beforeEach(() => { vi.mocked(readFile).mockReset(); vi.mocked(readFile).mockImplementation(actualFs.readFile); });
afterEach(async () => { vi.mocked(readFile).mockReset(); vi.mocked(readFile).mockImplementation(actualFs.readFile); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('packaged system prompt loading', () => {
  it('loads each complete prompt in system, agent, tools order from the module-relative directory', async () => {
    for (const document of documents) vi.mocked(readFile).mockResolvedValueOnce(document);
    await expect(loadSystemPrompt()).resolves.toBe(documents.map(document => document.trim()).join('\n\n'));
    expect(readFile).toHaveBeenCalledTimes(3);
    for (const [index, file] of promptFiles.entries()) {
      const [path, encoding] = vi.mocked(readFile).mock.calls[index]!;
      expect(path).toBeInstanceOf(URL); expect(fileURLToPath(path as URL)).toBe(fileURLToPath(new URL('../prompts/' + file, import.meta.url))); expect(encoding).toBe('utf8');
    }
  });
  it.each(promptFiles)('fails explicitly for missing %s without a cwd fallback', async missing => {
    for (const [index, file] of promptFiles.entries()) {
      if (file === missing) vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      else vi.mocked(readFile).mockResolvedValueOnce(documents[index]!);
    }
    await expect(loadSystemPrompt()).rejects.toThrow('提示词加载失败：prompts/' + missing + '，请重新构建或安装完整程序。');
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(vi.mocked(readFile).mock.calls.every(([path]) => path instanceof URL)).toBe(true);
  });
  it.each(promptFiles)('fails explicitly for whitespace-only %s without a cwd fallback', async empty => {
    for (const [index, file] of promptFiles.entries()) vi.mocked(readFile).mockResolvedValueOnce(file === empty ? ' \r\n\t ' : documents[index]!);
    await expect(loadSystemPrompt()).rejects.toThrow('提示词文件为空：prompts/' + empty);
    expect(readFile).toHaveBeenCalledTimes(3);
  });
  it('fails runtime readiness without creating a provider and releases the session lock on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvion-prompt-failure-')); roots.push(root);
    const store = await SessionStore.create(root, root);
    const providerFactory = vi.fn(() => { throw new Error('provider must not be created'); });
    vi.mocked(readFile).mockResolvedValueOnce(documents[0]!).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' })).mockResolvedValueOnce(documents[2]!);
    const agent = new AgentRuntime({ store, config: { version: 1, profiles: [{ id: 'test', name: '测试', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', apiKey: 'local-test-key', model: 'custom', contextWindow: 100000, maxOutputTokens: 5000 }], activeProfileId: 'test' }, executor: { definitions: [], execute: async () => ({ content: 'done' }) }, providerFactory });
    try {
      await expect(agent.ready()).rejects.toThrow('提示词加载失败：prompts/agent.md');
      expect(agent.getSnapshot()).toMatchObject({ status: 'failed', error: expect.stringContaining('prompts/agent.md') });
      await agent.send('任务'); expect(providerFactory).not.toHaveBeenCalled();
    } finally { await agent.close().catch(() => undefined); }
    await expect(actualFs.readFile(join(store.dir, 'lock.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = await SessionStore.resume(store.info.id, root); await reopened.close();
  });
});
