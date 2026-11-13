import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, toolDetailLines, transcriptRows, type UIRuntime } from '../cli/app.js';
import { Welcome, welcomeLayout, foxLarge, foxSmall } from '../cli/welcome.js';
import { ConfigForm, createProfileForm, fieldKeys, formFields, profileFromForm } from '../cli/config-form.js';
import { cursorPosition, deleteBackward, deleteForward, graphemes, insertText, lineBoundary, moveCursor, moveVertical, safeText, sliceColumns, wrapLines } from '../cli/editor.js';
import { markdownRows } from '../cli/markdown.js';
import { loadConfig, parseTokenCount } from '../core/config.js';
import type { RuntimeSnapshot } from '../core/types.js';

const dirs: string[] = [];
afterEach(async () => { cleanup(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
function fakeRuntime(overrides: Partial<RuntimeSnapshot> = {}): UIRuntime {
  const snapshot: RuntimeSnapshot = { sessionId: 'a1b2c3d4', title: '测试会话', cwd: 'D:/中文 项目', status: 'idle', permission: 'ask', entries: [], contextPercent: 42, estimated: true, todos: [], restored: false, compactPending: false, ...overrides };
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, send: vi.fn(async () => {}), cancel: vi.fn(), compact: vi.fn(async () => {}), selectProfile: vi.fn(), cancelPendingProfile: vi.fn(), setPermission: vi.fn(), approve: vi.fn(), answer: vi.fn(), updateConfig: vi.fn(), close: vi.fn(async () => {}) };
}

describe('Chinese grapheme editor', () => {
  it('inserts and deletes whole graphemes, including composed accents', () => {
    const state = insertText({ text: '你好', cursor: 1 }, 'e\u0301');
    expect(graphemes(state.text)).toEqual(['你', 'e\u0301', '好']);
    expect(deleteBackward(state)).toEqual({ text: '你好', cursor: 1 });
    expect(deleteForward({ text: '你好', cursor: 0 }).text).toBe('好');
    expect(moveCursor(state, 100).cursor).toBe(3);
  });
  it('wraps by terminal display columns and preserves blank lines', () => {
    expect(wrapLines('你好abcd\n\n世界', 4)).toEqual(['你好', 'abcd', '', '世界']);
    expect(cursorPosition({ text: '你好a', cursor: 3 }, 4)).toEqual({ x: 1, y: 1 });
    expect(lineBoundary({ text: 'ab\n你好', cursor: 4 }, false).cursor).toBe(3);
    expect(moveVertical({ text: 'ab\n你好', cursor: 2 }, 1).cursor).toBe(4);
  });
  it('cleans terminal control sequences but preserves multiline paste', () => {
    expect(safeText('\u001b]52;c;attack\u0007你好\r\n/exit')).toBe('你好\n/exit');
    expect(safeText('第一行\r第二行')).toBe('第一行\n第二行');
    expect(insertText({ text: '', cursor: 0 }, '第一行\n/exit').text).toBe('第一行\n/exit');
  });
  it('slices tool lines by display columns without splitting a Chinese glyph', () => {
    expect(sliceColumns('甲乙abc', 2, 3)).toBe('乙a');
    expect(sliceColumns('甲乙abc', 1, 3)).toBe(' 乙');
    expect(stringWidth(sliceColumns('甲乙abc', 1, 3))).toBe(3);
  });
});

describe('basic readable Markdown', () => {
  it('formats headings bold spans lists and code without markup noise', () => {
    const rows = markdownRows('# 标题\n这是**重点**和 `code`\n* 第一项\n```ts\nconst value = 1;\n```', 60);
    expect(rows[0]).toMatchObject({ text: '标题', bold: true });
    expect(rows.some(row => row.segments?.some(segment => segment.text === '重点' && segment.bold))).toBe(true);
    expect(rows.map(row => row.text).join('\n')).toContain('- 第一项');
    expect(rows.some(row => row.code && row.text.includes('const value'))).toBe(true);
    expect(rows.map(row => row.text).join('\n')).not.toContain('**');
  });
  it('renders basic tables with aligned readable Chinese cells', () => {
    const rows = markdownRows('| 字段 | 值 |\n| --- | --- |\n| 模型 | 自定义 |\n| 输出 | 384k |', 60);
    expect(rows[0]?.bold).toBe(true); expect(rows[1]?.text).toContain('┼');
    expect(rows.map(row => row.text).join('\n')).toContain('384k');
    expect(rows.every(row => stringWidth(row.text) <= 60)).toBe(true);
  });
});

describe('responsive welcome artwork', () => {
  it('uses actual fox Braille assets, not placeholders', () => {
    expect(foxLarge).toHaveLength(30); expect(foxSmall).toHaveLength(19);
    expect(foxLarge.join('')).toMatch(/[\u2800-\u28ff]/u);
    expect(foxLarge.join('')).not.toContain('[狐狸');
  });
  it.each([[160,48,'large'],[120,36,'compact'],[80,24,'stacked'],[60,18,'minimal'],[59,18,'too-small'],[160,17,'too-small']] as const)('selects %s x %s layout', (columns,rows,expected) => { expect(welcomeLayout(columns,rows)).toBe(expected); });
  it.each([[160,48],[120,36],[80,24],[60,18]])('renders truthful status within %s columns', async (columns, rows) => {
    const app = render(<Welcome columns={columns!} rows={rows!} bashAvailable={false} bashError="Bash 未安装" providerConfigured={false} />); await pause();
    const frame = stripAnsi(app.lastFrame() ?? '');
    expect(frame).toContain('未配置'); expect(frame).toContain('不可用'); expect(frame).not.toContain('Ready');
    expect(Math.max(...frame.split('\n').map(line => stringWidth(line)))).toBeLessThanOrEqual(columns!);
  });
});

describe('profile form', () => {
  it('requires per-model capacities and accepts custom models', () => {
    const empty = createProfileForm(); expect(empty.context).toBe(''); expect(empty.output).toBe('');
    const model = profileFromForm({ ...empty, name: '私有服务', baseUrl: 'https://example.com/v1', apiKey: '  local-test-key  ', model: 'custom-model', context: '512k', output: '256k' }, parseTokenCount);
    expect(model.contextWindow).toBe(512000); expect(model.maxOutputTokens).toBe(256000); expect(model.apiKey).toBe('local-test-key'); expect(model).not.toHaveProperty('apiKeyEnv');
  });
  it('rejects insecure remote URLs and invalid capacities', () => {
    const base = { ...createProfileForm(), name: 'custom', model: 'model', apiKey: 'local-test-key', context: '1m', output: '384k' };
    expect(() => profileFromForm({ ...base, baseUrl: 'http://example.com' }, parseTokenCount)).toThrow('HTTPS');
    expect(() => profileFromForm({ ...base, output: '2m' }, parseTokenCount)).toThrow('小于');
    expect(() => profileFromForm({ ...base, context: '' }, parseTokenCount)).toThrow();
  });
  it('removes the environment field and keeps the local key masked', async () => {
    expect(fieldKeys).toEqual(['name', 'protocol', 'baseUrl', 'apiKey', 'model', 'context', 'output', 'outputParameter']);
    expect(formFields).toHaveLength(fieldKeys.length + 1);
    const form = { ...createProfileForm(), apiKey: 'local-test-key' }; expect(form).not.toHaveProperty('apiKeyEnv');
    const app = render(<ConfigForm form={form} focused={3} columns={100} height={30} saving={false} />); await pause();
    expect(app.lastFrame()).not.toContain('环境变量'); expect(app.lastFrame()).not.toContain('local-test-key'); expect(app.lastFrame()).toContain('*'.repeat(14));
  });
  it.each(['', '   '])('requires a local API key: %j', apiKey => {
    const form = { ...createProfileForm(), name: 'custom', model: 'model', apiKey, apiKeyEnv: 'ELVION_TEST_KEY', context: '1m', output: '384k' };
    vi.stubEnv('ELVION_TEST_KEY', 'env-key'); expect(() => profileFromForm(form, parseTokenCount)).toThrow('请填写 API Key。');
  });
  it('navigates the shortened form, toggles parameters and saves a usable local key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'elvion-form-')); dirs.push(home); vi.stubEnv('ELVION_HOME', home);
    const runtime = fakeRuntime(); const saved = vi.fn();
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 64 }} initialOverlay="profiles" onConfigSaved={saved} />); await pause();
    const press = async (input: string) => { app.stdin.write(input); await pause(); };
    await press('\r'); await press('\r');
    await press('\u001b[Z'); expect(app.lastFrame()).toContain('> 保存配置'); await press('\t'); expect(app.lastFrame()).toContain('> 供应商名称');
    await press('\u0015'); await press('测试供应商'); await press('\r'); await press('\u001b[C');
    await press('\t'); await press('https://example.com/v1');
    await press('\t'); await press('local-test-key'); expect(app.lastFrame()).not.toContain('local-test-key');
    await press('\t'); expect(app.lastFrame()).toContain('> 模型名称'); await press('custom-model');
    await press('\t'); await press('1m'); await press('\t'); await press('384k');
    await press('\t'); expect(app.lastFrame()).toContain('> Chat 输出参数');
    await press('\u001b[C'); expect(app.lastFrame()).not.toContain('max_completion_tokens'); expect(app.lastFrame()).toContain('max_tokens');
    await press('\u001b[D'); expect(app.lastFrame()).toContain('max_completion_tokens'); await press('\u001b[C');
    await press('\t'); expect(app.lastFrame()).toContain('> 保存配置'); await press('\r');
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const config = await loadConfig(home); expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0]).toMatchObject({ name: '测试供应商', protocol: 'openai-chat', apiKey: 'local-test-key', model: 'custom-model', contextWindow: 1_000_000, maxOutputTokens: 384_000, outputParameter: 'max_tokens' });
    expect(config.profiles[0]).not.toHaveProperty('apiKeyEnv'); expect(runtime.updateConfig).toHaveBeenCalledWith(config); expect(runtime.send).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('配置已保存'); expect(app.lastFrame()).not.toContain('local-test-key');
  });
});

describe('runtime interaction surfaces', () => {
  it.each([[0, '0%'], [0.0001, '<0.1%'], [0.04, '<0.1%'], [0.1, '0.1%'], [0.48, '0.5%'], [42.26, '42.3%'], [74.9, '74.9%'], [75, '75.0%'], [94.9, '94.9%'], [95, '95.0%'], [100, '100.0%']] as const)('shows nonzero context occupancy honestly at %s percent', async (contextPercent, expected) => {
    const runtime = fakeRuntime({ contextPercent, estimated: true, restored: true });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 60, rows: 18 }} />); await pause();
    const frame = stripAnsi(app.lastFrame() ?? '');
    expect(frame).toContain(`上下文 ${expected}（估算）`);
    expect(frame.split('\n')).toHaveLength(18); expect(Math.max(...frame.split('\n').map(line => stringWidth(line)))).toBeLessThanOrEqual(60);
  });
  it('refreshes the footer from estimates to measured context without losing small nonzero values', async () => {
    const runtime = fakeRuntime({ contextPercent: 0, estimated: true, restored: true });
    let update: ((snapshot: RuntimeSnapshot) => void) | undefined;
    runtime.subscribe = listener => { update = listener; return () => { update = undefined; }; };
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 80, rows: 24 }} />); await pause();
    expect(app.lastFrame()).toContain('上下文 0%（估算）');
    update?.({ ...runtime.getSnapshot(), contextPercent: 0.04, estimated: true }); await pause();
    expect(app.lastFrame()).toContain('上下文 <0.1%（估算）');
    update?.({ ...runtime.getSnapshot(), contextPercent: 0.32, estimated: false }); await pause();
    expect(app.lastFrame()).toContain('上下文 0.3%'); expect(app.lastFrame()).not.toContain('（估算）');
  });
  it('defaults approval to rejection and never approves typed y', async () => {
    const runtime = fakeRuntime({ status: 'approving', approval: { id: 'approval1', tool: 'bash', title: 'npm test', details: '命令：npm test\n工作目录：D:/项目\n超时：60s' } });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 34 }} />); await pause();
    app.stdin.write('y'); await pause(); expect(runtime.approve).not.toHaveBeenCalled();
    app.stdin.write('\r'); await pause(); expect(runtime.approve).toHaveBeenCalledWith(false);
  });
  it('preserves busy draft and does not queue or send it', async () => {
    const runtime = fakeRuntime({ status: 'requesting', restored: true });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 34 }} />); await pause();
    app.stdin.write('你好'); await pause(); app.stdin.write('\r'); await pause();
    expect(runtime.send).not.toHaveBeenCalled(); expect(app.lastFrame()).toContain('没有排队'); expect(app.lastFrame()).toContain('你好');
  });
  it('keeps the draft when a configured profile lacks credentials', async () => {
    const profile = { id: 'p1', name: '测试', protocol: 'openai-chat' as const, baseUrl: 'https://example.com/v1', model: 'model', contextWindow: 512000, maxOutputTokens: 256000, apiKeyEnv: 'ELVION_TEST_UNSET_KEY' };
    vi.stubEnv('ELVION_TEST_UNSET_KEY', 'legacy-env-key');
    const runtime = fakeRuntime({ profile, restored: true });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [profile] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 34 }} />); await pause();
    app.stdin.write('保留这条任务'); await pause(); app.stdin.write('\r'); await pause();
    expect(runtime.send).not.toHaveBeenCalled(); expect(app.lastFrame()).toContain('缺少可用密钥'); expect(app.lastFrame()).toContain('保留这条任务');
  });
  it('opens tool details on an actual F2 escape sequence', async () => {
    const runtime = fakeRuntime({ restored: true, entries: [{ id: 'tool1', kind: 'tool', timestamp: '2026-11-12T12:00:00Z', content: 'output', toolName: 'bash', status: '完成' }] });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 34 }} />); await pause();
    app.stdin.write('\u001bOQ'); await pause(); expect(app.lastFrame()).toContain('工具记录');
  });
  it('shows todo statuses within the history without obscuring permission footer', async () => {
    const runtime = fakeRuntime({ restored: true, todos: [{ text: '检查代码', status: 'completed' }, { text: '修复缺陷', status: 'in_progress' }, { text: '验证结果', status: 'pending' }] });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 34 }} />); await pause();
    const frame = app.lastFrame() ?? ''; expect(frame).toContain('[x] 检查代码'); expect(frame).toContain('[>] 修复缺陷'); expect(frame).toContain('[ ] 验证结果'); expect(frame).toContain('每次询问');
  });
  it('moves tool details horizontally without changing their vertical anchor', async () => {
    const runtime = fakeRuntime({ restored: true, entries: [{ id: 'tool1', kind: 'tool', timestamp: '2026-11-12T12:00:00Z', content: 'BEGIN:' + 'a'.repeat(90) + ':END', output: 'BEGIN:' + 'a'.repeat(90) + ':END', toolName: 'bash', status: '完成' }] });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 80, rows: 24 }} />); await pause();
    app.stdin.write('\u001bOQ'); await pause(); app.stdin.write('\r'); await pause();
    expect(app.lastFrame()).toContain('横移 0 列');
    const before = stripAnsi(app.lastFrame() ?? '').split('\n'); const anchor = before.findLastIndex(line => line.includes('BEGIN:')); expect(anchor).toBeGreaterThan(0);
    app.stdin.write('\u001b[C'); await pause(); expect(app.lastFrame()).toContain('横移 8 列');
    const after = stripAnsi(app.lastFrame() ?? '').split('\n'); expect(after[anchor]).not.toContain('BEGIN:'); expect(after[anchor]).toContain('a'.repeat(30));
    app.stdin.write('\u001b[D'); await pause(); expect(app.lastFrame()).toContain('横移 0 列');
  });
  it('keeps multiline commands and code as original logical lines in details', () => {
    const lines = toolDetailLines({ id: 't1', kind: 'tool', timestamp: '2026-11-12T12:00:00Z', content: 'output', toolCall: { id: 't1', name: 'bash', arguments: { command: 'printf hello\nprintf world', cwd: 'D:/项目' } } });
    expect(lines).toContain('printf hello'); expect(lines).toContain('printf world'); expect(lines.join('\n')).not.toContain('hello\\n');
  });
  it.each([[160,48],[120,36],[80,24],[60,18]])('keeps todo and footer visible within a %s x %s session frame', async (columns, rows) => {
    const runtime = fakeRuntime({ restored: true, todos: Array.from({ length: 6 }, (_, index) => ({ text: `任务 ${index}`, status: 'pending' as const })), entries: [{ id: 'a1', kind: 'assistant', timestamp: '2026-11-12T12:00:00Z', content: '# 测试标题\n这是**重点**和 `code`\n\n- 第一项\n- 第二项' }] });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: columns!, rows: rows! }} />); await pause();
    const frame = stripAnsi(app.lastFrame() ?? ''); const lines = frame.split('\n');
    expect(lines.length).toBeLessThanOrEqual(rows!); expect(Math.max(...lines.map(line => stringWidth(line)))).toBeLessThanOrEqual(columns!);
    expect(frame).toContain('[ ] 任务 0'); expect(frame).toContain('每次询问'); expect(frame).toContain('描述你想完成的任务');
  });
  it('answers only a submitted user question and supports cancellation', async () => {
    const runtime = fakeRuntime({ status: 'answering', question: { id: 'q1', question: '选择测试方式', options: ['单元测试', '完整测试'] } });
    const app = render(<App runtime={runtime} config={{ version: 1, profiles: [] }} bash={{ available: true }} dimensions={{ columns: 100, rows: 34 }} />); await pause();
    expect(runtime.answer).not.toHaveBeenCalled(); app.stdin.write('\u001b'); await pause(); expect(runtime.answer).toHaveBeenCalledWith(null);
  });
  it('renders unknown tool result honestly and folds long output', () => {
    const rows = transcriptRows([{ id: 't1', kind: 'tool', content: Array.from({length:12},(_,i)=>`line ${i}`).join('\n'), timestamp: '2026-11-12T12:00:00Z', toolName: 'bash', status: '结果未知' }], 80);
    expect(rows.map(row=>row.text).join('\n')).toContain('结果未知'); expect(rows.map(row=>row.text).join('\n')).toContain('已折叠 4 行');
    expect(rows.map(row=>row.text).join('\n')).not.toContain('[完成]');
  });
});
