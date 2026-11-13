import React from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text } from 'ink';
import type { ModelProfile, Protocol } from '../core/types.js';
import { theme } from './welcome.js';
import { truncate } from './editor.js';

export const protocolOptions: Protocol[] = ['openai-responses', 'openai-chat', 'anthropic'];
export interface ProfileForm { id: string; name: string; protocol: Protocol; baseUrl: string; apiKey: string; model: string; context: string; output: string; outputParameter: 'max_tokens' | 'max_completion_tokens' }
export const formFields = ['供应商名称', '协议（左右键切换）', 'API 地址', 'API Key（本地保存，掩码）', '模型名称', '上下文容量（必填，例如 1m）', '最大输出（必填，例如 384k）', 'Chat 输出参数（左右键切换）', '保存配置'] as const;
export const fieldKeys = ['name', 'protocol', 'baseUrl', 'apiKey', 'model', 'context', 'output', 'outputParameter'] as const;
export function createProfileForm(profile?: ModelProfile): ProfileForm {
  return { id: profile?.id ?? randomUUID(), name: profile?.name ?? '', protocol: profile?.protocol ?? 'openai-responses', baseUrl: profile?.baseUrl ?? 'https://api.openai.com/v1', apiKey: profile?.apiKey ?? '', model: profile?.model ?? '', context: profile ? String(profile.contextWindow) : '', output: profile ? String(profile.maxOutputTokens) : '', outputParameter: profile?.outputParameter ?? 'max_completion_tokens' };
}
export const presets = [
  { name: '自定义供应商', protocol: 'openai-responses' as const, baseUrl: '' },
  { name: 'OpenAI Responses', protocol: 'openai-responses' as const, baseUrl: 'https://api.openai.com/v1' },
  { name: 'OpenAI Chat Completions', protocol: 'openai-chat' as const, baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', protocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1' },
];
export function profileFromForm(form: ProfileForm, parseTokens: (value: string) => number): ModelProfile {
  if (!form.name.trim() || !form.model.trim()) throw new Error('供应商名称和模型名称为必填项。');
  const url = new URL(form.baseUrl.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('API 地址必须使用 HTTPS；仅本机测试地址允许 HTTP，不能包含凭据、查询或片段。');
  if (!form.apiKey.trim()) throw new Error('请填写 API Key。');
  const contextWindow = parseTokens(form.context); const maxOutputTokens = parseTokens(form.output);
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens) || contextWindow <= 0 || maxOutputTokens <= 0 || maxOutputTokens >= contextWindow) throw new Error('上下文和输出必须为正整数，最大输出须小于上下文容量。');
  return { id: form.id, name: form.name.trim(), protocol: form.protocol, baseUrl: url.toString().replace(/\/$/, ''), model: form.model.trim(), contextWindow, maxOutputTokens, outputParameter: form.outputParameter, apiKey: form.apiKey.trim() };
}
export function ConfigForm({ form, focused, columns, height, error, saving }: { form: ProfileForm; focused: number; columns: number; height: number; error?: string; saving: boolean }): React.JSX.Element {
  const visible = Math.max(2, Math.floor((height - 7) / 2)); const start = Math.max(0, Math.min(focused - visible + 1, formFields.length - visible));
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={columns - 4} height={height} flexShrink={0} overflow="hidden">
    <Text color={theme.text} bold>供应商与模型配置（仅保存，不自动连接验证）</Text>
    <Text color={theme.muted}>Tab 切换字段 · Ctrl+U 清空当前字段 · Esc 返回</Text>
    {formFields.slice(start, start + visible).map((label, offset) => { const index = start + offset; const key = fieldKeys[index]; const value = key ? key === 'apiKey' ? (form.apiKey ? '*'.repeat(Math.min(form.apiKey.length, 24)) : '未填写') : form[key] : saving ? '保存中…' : '[保存配置]'; return <Box key={label} flexDirection="column"><Text color={index === focused ? theme.accent : theme.muted}>{index === focused ? '> ' : '  '}{label}</Text><Text inverse={index === focused} color={theme.text}>{truncate(String(value || ' '), columns - 10)}</Text></Box>; })}
    {error && <Text color={theme.error}>{truncate(error, columns - 10)}</Text>}
  </Box>;
}
