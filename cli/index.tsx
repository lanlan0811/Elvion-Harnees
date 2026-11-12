#!/usr/bin/env node
import React, { useState } from 'react';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { Box, Text, render, renderToString, useApp, useInput, useWindowSize } from 'ink';
import { loadConfig, getAppHome, resolveApiKey } from '../core/config.js';
import { sanitize } from '../core/security.js';
import type { AppConfig, SessionInfo } from '../core/types.js';
import { SessionStore } from '../runtime/session.js';
import { AgentRuntime } from '../runtime/agent.js';
import { inspectBash } from '../execution/bash.js';
import { App } from './app.js';
import { theme, Welcome } from './welcome.js';
import { truncate } from './editor.js';
import { diagnoseSessionLocks } from './doctor.js';

const help = [
  'ELVION CLI v0.1.0', 'Your Partner in Action.', '', '用法：',
  '  elvion                  在当前目录开始会话',
  '  elvion resume [id]      恢复指定或最近未占用的会话',
  '  elvion sessions         浏览并恢复会话',
  '  elvion config           配置供应商、模型与容量',
  '  elvion doctor           检查运行环境（非交互可用）',
  '  elvion --preview [宽 高] 输出欢迎页静态预览（不执行任务）',
  '  elvion --help           显示帮助', '  elvion --version        显示版本', '',
  '输入 Enter 发送；Ctrl+J 换行；Ctrl+C 取消当前轮，空闲时退出。',
  'Windows 只使用随包 PortableGit；macOS 只使用 /bin/bash。', '',
].join('\n');

function SessionPicker({ sessions, onChoose }: { sessions: SessionInfo[]; onChoose: (id: string) => void }): React.JSX.Element {
  const [selected, setSelected] = useState(0); const { exit } = useApp(); const { columns, rows } = useWindowSize();
  const visible = Math.max(1, Math.floor((rows - 5) / 2)); const start = Math.max(0, selected - visible + 1);
  useInput((input, key) => {
    if (key.escape || key.ctrl && input === 'c') exit();
    else if (key.upArrow) setSelected(value => Math.max(0, value - 1));
    else if (key.downArrow) setSelected(value => Math.min(sessions.length - 1, value + 1));
    else if (key.return) { const session = sessions[selected]; if (session && !session.locked) { onChoose(session.id); exit(); } }
  });
  return <Box flexDirection="column" padding={1} width={columns} height={rows} backgroundColor={theme.background}>
    <Text color={theme.accent} bold>ELVION 会话记录</Text>
    <Text color={theme.muted}>方向键选择 · Enter 恢复 · Esc 返回；占用中的会话不可恢复。</Text>
    {!sessions.length && <Text color={theme.text}>尚无会话。在项目目录执行 elvion 新建。</Text>}
    {sessions.slice(start, start + visible).map((session, index) => <Box key={session.id} flexDirection="column"><Text inverse={start + index === selected} color={session.locked ? theme.warning : theme.text}>{truncate(`${start + index === selected ? '> ' : '  '}${session.title} [${session.id.slice(0, 8)}] ${session.locked ? '占用中' : '可恢复'} ${session.updatedAt}`, Math.max(1, columns - 4))}</Text><Text color={theme.muted}>{truncate(`  ${session.cwd}`, Math.max(1, columns - 4))}</Text></Box>)}
  </Box>;
}

async function doctor(): Promise<number> {
  const bash = await inspectBash(); const checks: { name: string; state: string; details: string }[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js', state: major === 24 || major >= 26 ? '通过' : '失败', details: process.versions.node });
  checks.push({ name: 'Bash', state: bash.available ? '通过' : '失败', details: bash.path ?? bash.error ?? '未找到' });
  try {
    const config = await loadConfig(); checks.push({ name: '配置文件', state: '通过', details: `${config.profiles.length} 个模型配置` });
    for (const profile of config.profiles) { let present = true; try { resolveApiKey(profile); } catch { present = false; } checks.push({ name: `模型 ${profile.name} / ${profile.model}`, state: present ? '未验证' : '失败', details: present ? '配置及密钥存在；未请求真实 API' : '未配置可用密钥' }); }
  } catch (error) { checks.push({ name: '配置文件', state: '失败', details: sanitize(error instanceof Error ? error.message : String(error)) }); }
  try { await access(getAppHome(), constants.R_OK | constants.W_OK); checks.push({ name: '会话目录', state: '通过', details: getAppHome() }); } catch { checks.push({ name: '会话目录', state: '未验证', details: '首次创建会话时初始化：' + getAppHome() }); }
  checks.push(...await diagnoseSessionLocks());
  checks.push({ name: '人工平台验收', state: '未验证', details: '中文 IME、真实终端视觉及真实供应商连接需要单独验收' });
  process.stdout.write(checks.map(check => `[${check.state}] ${check.name}：${check.details}`).join('\n') + '\n');
  return checks.some(check => check.state === '失败') ? 1 : 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return 0; }
  if (args.includes('--version') || args.includes('-v')) { process.stdout.write('0.1.0\n'); return 0; }
  const command = args[0];
  if (command === '--preview') {
    const columns = Number(args[1] ?? 160); const rows = Number(args[2] ?? 48);
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || columns > 500 || rows < 1 || rows > 200) throw new Error('预览尺寸无效：宽 1～500，高 1～200。');
    const bash = await inspectBash(); let configured = false; try { const config = await loadConfig(); configured = config.profiles.length > 0; } catch { /* preview reflects unconfigured state */ }
    const text = await renderToString(<Box width={columns} height={rows} flexDirection="column" paddingX={2} backgroundColor={theme.background}><Welcome columns={columns} rows={rows} bashAvailable={bash.available} bashError={bash.error} providerConfigured={configured} /><Text color={theme.border}>{'─'.repeat(Math.max(1, columns - 4))}</Text><Text color={theme.muted}>静态预览；未发起模型请求，未执行任务。</Text></Box>, { columns });
    process.stdout.write(text + '\n'); return 0;
  }
  if (command === 'doctor') return doctor();
  if (command && !['resume', 'sessions', 'config'].includes(command)) throw new Error('未知命令：' + sanitize(command) + '；使用 elvion --help 查看帮助。');
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('交互式 CLI 需要真实终端。可使用 elvion --help、elvion doctor 或 elvion --preview。\n'); return 1; }
  let chosenId: string | undefined;
  if (command === 'sessions') {
    const sessions = await SessionStore.list(); const picker = render(<SessionPicker sessions={sessions} onChoose={id => { chosenId = id; }} />, { alternateScreen: true, exitOnCtrlC: false });
    await picker.waitUntilExit(); if (!chosenId) return 0;
  }
  const config: AppConfig = await loadConfig(); const bash = await inspectBash();
  const store = command === 'resume' || chosenId ? await SessionStore.resume(chosenId ?? args[1]) : await SessionStore.create(resolve(process.cwd()));
  const runtime = new AgentRuntime({ store, config });
  const instance = render(<App runtime={runtime} config={config} bash={bash} initialOverlay={command === 'config' ? 'profiles' : undefined} />, { alternateScreen: true, exitOnCtrlC: false, maxFps: 30, incrementalRendering: true });
  const stop = () => { void runtime.close().finally(() => instance.unmount()); };
  process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  try { await instance.waitUntilExit(); } finally { process.off('SIGTERM', stop); process.off('SIGHUP', stop); await runtime.close(); }
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write('ELVION：' + sanitize(error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
