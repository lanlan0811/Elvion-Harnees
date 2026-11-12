import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { App, transcriptRows, type UIRuntime } from '../cli/app.js';
import { Welcome, welcomeLayout, foxLarge, foxSmall } from '../cli/welcome.js';
import { createProfileForm, profileFromForm } from '../cli/config-form.js';
import { cursorPosition, deleteBackward, deleteForward, graphemes, insertText, lineBoundary, moveCursor, moveVertical, safeText, wrapLines } from '../cli/editor.js';
import { parseTokenCount } from '../core/config.js';
import type { RuntimeSnapshot } from '../core/types.js';

afterEach(cleanup);
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
    const model = profileFromForm({ ...empty, name: '私有服务', baseUrl: 'https://example.com/v1', apiKeyEnv: 'MY_KEY', model: 'custom-model', context: '512k', output: '256k' }, parseTokenCount);
    expect(model.contextWindow).toBe(512000); expect(model.maxOutputTokens).toBe(256000); expect(model.apiKey).toBeUndefined();
  });
  it('rejects insecure remote URLs and invalid capacities', () => {
    const base = { ...createProfileForm(), name: 'custom', model: 'model', apiKeyEnv: 'MY_KEY', context: '1m', output: '384k' };
    expect(() => profileFromForm({ ...base, baseUrl: 'http://example.com' }, parseTokenCount)).toThrow('HTTPS');
    expect(() => profileFromForm({ ...base, output: '2m' }, parseTokenCount)).toThrow('小于');
    expect(() => profileFromForm({ ...base, context: '' }, parseTokenCount)).toThrow();
  });
});

describe('runtime interaction surfaces', () => {
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
    delete process.env.ELVION_TEST_UNSET_KEY;
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
