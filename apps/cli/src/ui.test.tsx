import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { brandLines, loadBrandAssets } from './ui/brand.js';
import { buildWelcomeFrame, frameToText, gradientColor, noColor, selectLayout } from './ui/layout.js';
import { parseSubmission, SLASH_COMMANDS, transitionInput } from './ui/input.js';
import { messageLines, messageViewport } from './ui/messages.js';
import { cellWidth, cleanText, truncate, wrapText } from './ui/text.js';
import type { UiHealth } from './ui/types.js';
import { ElvionApp, approvalLines, inputLines } from './ui/app.js';
import type { ElvionAppProps } from './ui/types.js';

const assetDirectory = fileURLToPath(new URL('../../../assets/brand/', import.meta.url));
const assets = await loadBrandAssets(assetDirectory);
const health: UiHealth = { runtime: { state: 'warning', label: '未配置模型' }, execution: { state: 'ok', label: 'Available' }, tools: { state: 'error', label: 'Git Bash missing' } };

describe('brand grid and responsive breakpoints', () => {
  it('loads original brand bytes and preserves every nonempty row and space', async () => {
    expect(assets.largeFox).toBe(await readFile(new URL('../../../assets/brand/elvion-fox-large.txt', import.meta.url), 'utf8'));
    expect(brandLines(assets.largeFox)).toHaveLength(28);
    expect(brandLines(assets.smallFox)).toHaveLength(18);
    expect(brandLines(assets.wordmark)).toHaveLength(7);
    expect(brandLines(assets.largeFox)[0]?.startsWith('                                             ')).toBe(true);
  });
  it.each([[160, 42, 'large'], [144, 36, 'large'], [143, 36, 'small'], [144, 35, 'small'], [116, 28, 'small'], [116, 27, 'wordmark'], [115, 28, 'wordmark'], [80, 24, 'wordmark'], [72, 24, 'wordmark'], [71, 24, 'compact'], [40, 12, 'compact']] as const)('selects %s×%s without overflowing', (columns, rows, layout) => {
    expect(selectLayout(columns, rows)).toBe(layout);
    const frame = frameToText(buildWelcomeFrame({ columns, rows, assets, health, version: '0.1.0' }));
    expect(frame).toHaveLength(Math.max(0, rows - 8));
    expect(frame.every(value => cellWidth(value) <= columns)).toBe(true);
    expect(frame.join('\n')).toContain('未配置模型');
    expect(frame.join('\n')).not.toContain('Ready');
    if (layout === 'large' || layout === 'small') for (const foxLine of brandLines(layout === 'large' ? assets.largeFox : assets.smallFox)) expect(frame.some(value => value.includes(foxLine))).toBe(true);
    if (layout !== 'compact') for (const wordmarkLine of brandLines(assets.wordmark)) expect(frame.some(value => value.includes(wordmarkLine))).toBe(true);
  });
  it('continues to fit when the window is resized repeatedly', () => {
    for (const [columns, rows] of [[160, 42], [42, 16], [116, 28], [80, 24], [144, 36], [1, 1], [160, 42]]) {
      const frame = frameToText(buildWelcomeFrame({ columns: columns ?? 1, rows: rows ?? 1, assets, health, version: '9.8.7' }));
      expect(frame.every(value => cellWidth(value) <= (columns ?? 1))).toBe(true);
    }
  });
  it('uses no-color fallback and a stable cyan-blue-purple gradient', () => {
    expect(noColor({ NO_COLOR: '' })).toBe(true);
    expect(noColor({ TERM: 'dumb' })).toBe(true);
    expect(noColor({ COLORTERM: 'truecolor' })).toBe(false);
    expect(gradientColor(0, 3)).toBe('#70dcff');
    expect(gradientColor(1, 3)).toBe('#6fa0f4');
    expect(gradientColor(2, 3)).toBe('#a18dff');
  });
});

describe('input editing and command dispatch', () => {
  it('inserts Chinese and multi-line pasted text without submitting', () => {
    const pasted = transitionInput({ value: '', cursor: 0 }, '实现功能\r\n保留多行', {});
    expect(pasted).toEqual({ state: { value: '实现功能\n保留多行', cursor: 9 }, effect: 'none' });
    expect(transitionInput(pasted.state, '', { return: true }).effect).toBe('submit');
    expect(transitionInput({ value: 'a', cursor: 1 }, 'j', { ctrl: true }).state.value).toBe('a\n');
  });
  it('deletes and moves across whole Unicode graphemes', () => {
    const state = { value: '中文é', cursor: 3 };
    expect(transitionInput(state, '', { backspace: true }).state).toEqual({ value: '中文', cursor: 2 });
    expect(transitionInput(state, '', { leftArrow: true }).state.cursor).toBe(2);
    expect(transitionInput(state, 'c', { ctrl: true }).effect).toBe('interrupt');
    expect(transitionInput(state, '', { escape: true }).effect).toBe('escape');
    expect(transitionInput(state, '', { pageUp: true }).effect).toBe('scroll-up');
  });
  it('routes every supported slash command without executing user content', () => {
    for (const command of SLASH_COMMANDS) expect(parseSubmission(`/${command} example`)).toEqual({ type: 'command', command, args: 'example' });
    expect(parseSubmission('/permissions full-access')).toEqual({ type: 'command', command: 'permissions', args: 'full-access' });
    expect(parseSubmission('/unknown')).toEqual({ type: 'unknown-command', command: 'unknown' });
    expect(parseSubmission('  你好  ')).toEqual({ type: 'message', text: '你好' });
    expect(parseSubmission(' \n ')).toEqual({ type: 'empty' });
  });
  it('removes terminal controls and bounds input', () => {
    expect(cleanText('安全\u001b[2J文字\u0007')).toBe('安全文字');
    expect(transitionInput({ value: '', cursor: 0 }, 'x'.repeat(65_000), {}).state.value).toHaveLength(64_000);
    expect(truncate('你é好', 3)).toBe('你é');
    expect(wrapText('你好世界', 3)).toEqual(['你', '好', '世', '界']);
  });
});

describe('execution message viewport', () => {
  const messages = Array.from({ length: 30 }, (_, id) => ({ id: String(id), kind: 'tool' as const, title: `Tool ${id}`, text: `中文结果 ${id}\nsecond line` }));
  it('holds the newest output in a bounded viewport and scrolls back', () => {
    const latest = messageViewport(messages, 30, 12, 0);
    const older = messageViewport(messages, 30, 12, 12);
    expect(latest.lines).toHaveLength(12);
    expect(latest.hiddenAbove).toBeGreaterThan(0);
    expect(frameToText(latest.lines).join('\n')).toContain('Tool 29');
    expect(frameToText(older.lines).join('\n')).not.toContain('Tool 29');
    expect(messageViewport(messages, 30, 12, 99999).offset).toBe(108);
  });
  it('renders diff evidence with separate addition and removal tones', () => {
    const lines = messageLines([{ id: 'd', kind: 'diff', text: '--- old\n+++ new\n-removed\n+added' }], 40);
    expect(lines.find(line => line.parts[0]?.text === '-removed')?.parts[0]?.tone).toBe('error');
    expect(lines.find(line => line.parts[0]?.text === '+added')?.parts[0]?.tone).toBe('ok');
  });
});

describe('live Ink input and approvals', () => {
  function terminal(props: Partial<ElvionAppProps> = {}) {
    const onSubmit = vi.fn(); const onCommand = vi.fn(); const onCancel = vi.fn(); const onApproval = vi.fn();
    const input = new PassThrough();
    const raw = vi.fn();
    const stdin = Object.assign(input, { isTTY: true, setRawMode: raw, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream;
    let output = '';
    const stdout = Object.assign(new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } }), { columns: 160, rows: 42, isTTY: true }) as unknown as NodeJS.WriteStream;
    const allProps: ElvionAppProps = { version: '0.1.0', assets, health, permissionMode: 'auto-edit', messages: [], busy: false, workspace: '测试项目', onSubmit, onCommand, onCancel, onApproval, ...props };
    const app = render(createElement(ElvionApp, allProps), { stdin, stdout, stderr: stdout, exitOnCtrlC: false, patchConsole: false, maxFps: 120 });
    return { app, stdin, stdout, input, raw, onSubmit, onCommand, onCancel, onApproval, props: allProps, output: () => output };
  }
  it('uses the Ink parser for Enter, Ctrl+J, pasted Chinese and slash commands', async () => {
    const t = terminal();
    try {
      await vi.waitFor(() => expect(t.raw).toHaveBeenCalledWith(true));
      t.input.write('中文');
      await new Promise(resolve => setImmediate(resolve));
      t.input.write('\n');
      await new Promise(resolve => setImmediate(resolve));
      t.input.write('第二行');
      await new Promise(resolve => setImmediate(resolve));
      t.input.write('\r');
      await vi.waitFor(() => expect(t.onSubmit).toHaveBeenCalledExactlyOnceWith('中文\n第二行'));
      t.input.write('/help');
      await new Promise(resolve => setImmediate(resolve));
      t.input.write('\r');
      await vi.waitFor(() => expect(t.onCommand).toHaveBeenCalledExactlyOnceWith('help', ''));
      await vi.waitFor(() => {
        expect(t.output()).toContain('ELVION CLI v0.1.0');
        expect(t.output()).toContain('未配置模型');
      });
    } finally { t.app.unmount(); t.app.cleanup(); }
    expect(t.raw).toHaveBeenLastCalledWith(false);
  });
  it('rejects approvals on Escape, never accepts Enter, and only sends one decision', async () => {
    const t = terminal({ busy: true, approval: { id: 'approval-1', tool: 'bash', arguments: { command: 'echo test' }, cwd: '测试项目', scope: 'shell' } });
    try {
      await vi.waitFor(() => expect(t.raw).toHaveBeenCalledWith(true));
      t.input.write('\r');
      await new Promise(resolve => setImmediate(resolve));
      expect(t.onApproval).not.toHaveBeenCalled();
      t.input.write('\u001b');
      await vi.waitFor(() => expect(t.onApproval).toHaveBeenCalledExactlyOnceWith('approval-1', false));
      t.input.write('y');
      await new Promise(resolve => setImmediate(resolve));
      expect(t.onApproval).toHaveBeenCalledTimes(1);
    } finally { t.app.unmount(); t.app.cleanup(); }
  });
  it('cancels active execution with Ctrl+C instead of exiting', async () => {
    const t = terminal({ busy: true });
    try {
      await vi.waitFor(() => expect(t.raw).toHaveBeenCalledWith(true));
      t.input.write('\u0003');
      await vi.waitFor(() => expect(t.onCancel).toHaveBeenCalledTimes(1));
      expect(t.raw).not.toHaveBeenLastCalledWith(false);
    } finally { t.app.unmount(); t.app.cleanup(); }
  });
  it('redacts credential fields in approval summaries and keeps input bounded', () => {
    const approval = approvalLines({ id: 'a', tool: 'test', arguments: { token: 'do-not-show', nested: { apiKey: 'secret-value' }, command: 'echo okay' }, cwd: 'workspace', scope: 'shell' }, 40);
    const text = frameToText(approval).join('\n');
    expect(text).not.toContain('do-not-show'); expect(text).not.toContain('secret-value'); expect(text).toContain('[REDACTED]');
    expect(frameToText(inputLines({ value: '中文\n你好', cursor: 5 }, 8)).every(value => cellWidth(value) <= 8)).toBe(true);
  });
});
