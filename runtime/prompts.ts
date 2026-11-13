import { readFile } from 'node:fs/promises';

const promptFiles = ['system.md', 'agent.md', 'tools.md'] as const;

export async function loadSystemPrompt(): Promise<string> {
  const prompts = await Promise.all(promptFiles.map(async file => {
    let content: string;
    try { content = await readFile(new URL('../prompts/' + file, import.meta.url), 'utf8'); }
    catch { throw new Error('提示词加载失败：prompts/' + file + '，请重新构建或安装完整程序。'); }
    if (!content.trim()) throw new Error('提示词文件为空：prompts/' + file);
    return content.trim();
  }));
  return prompts.join('\n\n');
}
