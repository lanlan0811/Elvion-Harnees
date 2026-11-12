import React, { useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { Box, Text, useApp, useCursor, useInput, usePaste, useStdin, useWindowSize } from 'ink';
import type { AppConfig, PermissionMode, RuntimeSnapshot, TranscriptEntry } from '../core/types.js';
import { parseTokenCount, resolveApiKey, saveConfig } from '../core/config.js';
import { ConfigForm, createProfileForm, fieldKeys, formFields, presets, profileFromForm, protocolOptions, type ProfileForm } from './config-form.js';
import { cursorPosition, deleteBackward, deleteForward, graphemes, insertText, lineBoundary, moveCursor, moveVertical, safeText, sliceColumns, truncate, wrapLines, type EditorState } from './editor.js';
import { markdownRows, type MarkdownSegment } from './markdown.js';
import { theme, Welcome, welcomeLayout } from './welcome.js';

export interface UIRuntime {
  getSnapshot(): RuntimeSnapshot; subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  send(text: string): Promise<void>; cancel(): void; compact(): Promise<void>;
  selectProfile(id: string): void; cancelPendingProfile(): void; setPermission(mode: PermissionMode): void;
  approve(value: boolean): void; answer(value: string | null): void; updateConfig(config: AppConfig): void; close(): Promise<void>;
}
export const permissionLabels: Record<PermissionMode, string> = { ask: '每次询问', edit: '自动编辑', full: '完全访问' };
const statusLabels: Record<string, string> = { idle: '就绪', requesting: '请求模型中', approving: '等待确认', executing: '执行工具中', answering: '等待回答', compacting: '正在压缩', cancelled: '已取消', failed: '失败' };
const active = (status: RuntimeSnapshot['status']) => !['idle', 'cancelled', 'failed'].includes(status);
const commands = ['/provider', '/model', '/permissions', '/compact', '/help', '/exit'];
type Overlay = 'none' | 'profiles' | 'models' | 'presets' | 'form' | 'permissions' | 'permission-confirm' | 'help' | 'tools' | 'detail';
interface Row { text: string; color?: string; bold?: boolean; segments?: MarkdownSegment[] }

export function toolDetailLines(entry: TranscriptEntry): string[] {
  const argumentsText = Object.entries(entry.toolCall?.arguments ?? {}).flatMap(([key, value]) =>
    typeof value === 'string' && (value.includes('\n') || ['command', 'content', 'patch', 'old_text', 'new_text'].includes(key))
      ? [`${key}:`, value]
      : [`${key}: ${JSON.stringify(value)}`]).join('\n');
  return safeText(`参数\n${argumentsText || '{}'}\n\n输出\n${entry.output ?? entry.content}\n\n元数据\n${JSON.stringify(entry.metadata ?? {}, null, 2)}`).split('\n');
}

export function transcriptRows(entries: TranscriptEntry[], width: number): Row[] {
  const rows: Row[] = [];
  const add = (text: string, color = theme.text, bold = false) => { for (const line of wrapLines(text, width)) rows.push({ text: line, color, bold }); };
  for (const entry of entries) {
    const time = entry.timestamp.slice(11, 16);
    if (entry.kind === 'user') { add(`你  ${time}`, theme.accent, true); add(entry.content); }
    else if (entry.kind === 'assistant') {
      add('ELVION', theme.accent, true);
      rows.push(...markdownRows(entry.content, width).map(row => ({ ...row, color: row.code && row.text.trimStart().startsWith('+') ? theme.success : row.code && row.text.trimStart().startsWith('-') ? theme.error : theme.text })));
    }
    else if (entry.kind === 'system') add(`${time}  ${entry.content}`, /未知|压缩|75%|95%/.test(entry.content) ? theme.warning : theme.muted);
    else {
      const status = entry.metadata?.denied === true ? '已拒绝' : entry.status ?? '执行中';
      const color = /fail|error|失败/.test(status) ? theme.error : /unknown|未知|approve|确认|拒绝/.test(status) ? theme.warning : theme.muted;
      add(`> ${entry.toolName ?? 'tool'}  [${status}]`, color, true);
      if (entry.toolCall) add(JSON.stringify(entry.toolCall.arguments), theme.muted);
      const output = safeText(entry.output ?? entry.content).split('\n');
      if (output.length > 8) add(`  … 已折叠 ${output.length - 8} 行；F2 查看详情`, theme.muted);
      for (const line of output.slice(-8)) add('  ' + line, color);
    }
    rows.push({ text: '' });
  }
  return rows;
}

export interface AppProps { runtime: UIRuntime; config: AppConfig; bash: { available: boolean; error?: string }; dimensions?: { columns: number; rows: number }; initialOverlay?: 'profiles'; onConfigSaved?: (config: AppConfig) => void; onExit?: () => Promise<void> }
export function App({ runtime, config: initialConfig, bash, dimensions, initialOverlay, onConfigSaved, onExit }: AppProps): React.JSX.Element {
  const terminal = useWindowSize(); const columns = dimensions?.columns ?? terminal.columns; const rows = dimensions?.rows ?? terminal.rows;
  const { exit } = useApp(); const { setCursorPosition } = useCursor(); const { stdin } = useStdin();
  const [snapshot, setSnapshot] = useState(() => runtime.getSnapshot());
  const [config, setConfig] = useState(initialConfig);
  const [draft, setDraft] = useState<EditorState>({ text: '', cursor: 0 });
  const [overlay, setOverlay] = useState<Overlay>(initialOverlay ?? 'none');
  const [selected, setSelected] = useState(0); const [filter, setFilter] = useState('');
  const [scrollTop, setScrollTop] = useState<number | null>(null); const [dialogScroll, setDialogScroll] = useState(0);
  const [detailOffset, setDetailOffset] = useState(0);
  const [notice, setNotice] = useState(''); const [approvalChoice, setApprovalChoice] = useState(false);
  const [questionChoice, setQuestionChoice] = useState(0); const [answerDraft, setAnswerDraft] = useState<EditorState>({ text: '', cursor: 0 });
  const [form, setForm] = useState<ProfileForm>(() => createProfileForm()); const [formFocus, setFormFocus] = useState(0);
  const [formError, setFormError] = useState<string>(); const [saving, setSaving] = useState(false);
  const [targetPermission, setTargetPermission] = useState<PermissionMode>('ask'); const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [detailEntry, setDetailEntry] = useState<TranscriptEntry>();
  const closing = useRef(false);
  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);
  useEffect(() => { setApprovalChoice(false); setDialogScroll(0); }, [snapshot.approval?.id]);
  useEffect(() => { setQuestionChoice(0); setAnswerDraft({ text: '', cursor: 0 }); setDialogScroll(0); }, [snapshot.question?.id]);
  const tools = snapshot.entries.filter(entry => entry.kind === 'tool');
  const profileList = config.profiles.filter(profile => (overlay !== 'models' || !snapshot.profile || profile.baseUrl === snapshot.profile.baseUrl && profile.protocol === snapshot.profile.protocol) && `${profile.name} ${profile.model} ${profile.protocol}`.toLowerCase().includes(filter.toLowerCase()));
  const bodyWidth = Math.max(1, columns - 4); const inputWidth = Math.max(1, columns - 6);
  const inputLines = wrapLines(draft.text || '', inputWidth); const cursor = cursorPosition(draft, inputWidth);
  const inputHeight = Math.max(1, Math.min(rows < 24 ? 2 : 6, Math.max(inputLines.length, cursor.y + 1)));
  const inputStart = Math.max(0, cursor.y - inputHeight + 1);
  const hasRuntimeDialog = !!snapshot.approval || !!snapshot.question;
  const hasDialog = hasRuntimeDialog || overlay !== 'none';
  const dialogHeight = hasDialog ? Math.max(7, Math.min(Math.floor(rows * 0.58), rows - 8)) : 0;
  const historyHeight = Math.max(1, rows - 2 - 1 - inputHeight - 1 - 2 - (notice ? 1 : 0) - dialogHeight);
  const entries = useMemo(() => transcriptRows(snapshot.entries, bodyWidth), [snapshot.entries, bodyWidth]);
  const todoHeight = snapshot.todos.length ? Math.min(4, Math.max(1, Math.floor(historyHeight / 4))) : 0;
  const transcriptHeight = Math.max(1, historyHeight - todoHeight);
  const maxScroll = Math.max(0, entries.length - transcriptHeight);
  const historyStart = scrollTop === null ? maxScroll : Math.min(maxScroll, scrollTop);
  const visibleRows = entries.slice(historyStart, historyStart + transcriptHeight);
  const welcome = snapshot.entries.length === 0 && !snapshot.restored;
  const tooSmall = welcomeLayout(columns, rows) === 'too-small';
  const isBusy = active(snapshot.status);
  if (!hasDialog && !tooSmall) setCursorPosition({ x: 4 + cursor.x, y: rows - 3 - inputHeight + cursor.y - inputStart });
  else setCursorPosition(undefined);

  const open = (value: Overlay) => { setOverlay(value); setSelected(0); setFilter(''); setDialogScroll(0); setDetailOffset(0); setFormError(undefined); };
  useEffect(() => {
    // Ink suppresses function-key names in useInput; observe only F2 without consuming the stream.
    let suffix = ''; let pasted = false;
    const onData = (chunk: Buffer | string) => {
      const value = suffix + chunk.toString(); suffix = value.slice(-6);
      if (value.includes('\u001b[200~')) pasted = true;
      if (pasted) { if (value.includes('\u001b[201~')) { pasted = false; suffix = ''; } return; }
      // Match only the terminal's F2 escape sequence; never render its bytes.
      if (/\u001b(?:OQ|\[12~|\[\[B)/.test(value) && overlay === 'none' && !hasRuntimeDialog && !tooSmall) { setOverlay('tools'); setSelected(0); setDialogScroll(0); suffix = ''; }
    };
    stdin.on('data', onData); return () => { stdin.off('data', onData); };
  }, [stdin, overlay, hasRuntimeDialog, tooSmall]);
  const report = (error: unknown) => setNotice(error instanceof Error ? safeText(error.message) : '操作失败');
  const quit = async () => {
    if (closing.current) return; closing.current = true;
    try { await runtime.close(); if (onExit) await onExit(); exit(); } catch (error) { closing.current = false; report(error); }
  };
  const invoke = (callback: () => void) => { try { callback(); } catch (error) { report(error); } };
  const runCommand = (command: string): boolean => {
    if (command === '/provider') open('profiles');
    else if (command === '/model') open('models');
    else if (command === '/permissions') open('permissions');
    else if (command === '/help') open('help');
    else if (command === '/compact') { void runtime.compact().catch(report); setNotice(isBusy ? '将在安全边界压缩上下文' : '正在压缩当前会话'); }
    else if (command === '/exit') void quit();
    else return false;
    return true;
  };
  const submit = () => {
    const text = draft.text.trim(); if (!text) return;
    if (runCommand(text)) { setDraft({ text: '', cursor: 0 }); return; }
    if (text.startsWith('/')) { setNotice('未知命令，输入 /help 查看命令。'); return; }
    if (isBusy) { setNotice('当前轮结束后可发送；草稿已保留，没有排队。'); return; }
    if (!bash.available) { setNotice('Bash 不可用，请先运行 elvion doctor。'); return; }
    if (!snapshot.profile) { open('profiles'); setNotice('先配置供应商与模型，草稿已保留。'); return; }
    try { resolveApiKey(snapshot.profile); } catch { open('profiles'); setNotice('当前模型缺少可用密钥，请编辑配置；草稿已保留。'); return; }
    setNotice(''); setScrollTop(null); setDraft({ text: '', cursor: 0 }); void runtime.send(text).catch(report);
  };
  const saveForm = async () => {
    if (saving) return;
    try {
      const profile = profileFromForm(form, parseTokenCount); setSaving(true); setFormError(undefined);
      const next: AppConfig = { version: 1, profiles: [...config.profiles.filter(item => item.id !== profile.id), profile], activeProfileId: config.activeProfileId ?? profile.id };
      await saveConfig(next); setConfig(next); runtime.updateConfig(next); onConfigSaved?.(next);
      if (!snapshot.profile) runtime.selectProfile(profile.id);
      setNotice('配置已保存；尚未验证真实连接。'); open('profiles');
    } catch (error) { setFormError(error instanceof Error ? safeText(error.message) : '保存失败'); }
    finally { setSaving(false); }
  };
  const editFormText = (input: string, backspace = false, clear = false) => {
    const key = fieldKeys[formFocus]; if (!key || key === 'protocol' || key === 'outputParameter') return;
    setForm(value => ({ ...value, [key]: clear ? '' : backspace ? graphemes(value[key]).slice(0, -1).join('') : value[key] + safeText(input).replace(/\n/g, '') }));
  };
  usePaste(text => {
    if (tooSmall || snapshot.approval) return;
    if (snapshot.question) { setQuestionChoice(snapshot.question.options?.length ?? 0); setAnswerDraft(value => insertText(value, text)); return; }
    if (overlay === 'form') { editFormText(text); return; }
    if (overlay !== 'none') return;
    setDraft(value => insertText(value, text));
  });
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') { if (isBusy) runtime.cancel(); else void quit(); return; }
    if (tooSmall) return;
    if (hasDialog && (key.pageUp || key.pageDown || (key.ctrl && key.end))) { setDialogScroll(value => key.ctrl && key.end ? Number.MAX_SAFE_INTEGER : Math.max(0, value + (key.pageDown ? 5 : -5))); return; }
    if (snapshot.approval) {
      if (key.escape) runtime.approve(false);
      else if (key.tab || key.leftArrow || key.rightArrow) setApprovalChoice(value => !value);
      else if (key.return) runtime.approve(approvalChoice);
      return;
    }
    if (snapshot.question) {
      const options = snapshot.question.options ?? [];
      if (key.escape) runtime.answer(null);
      else if (key.upArrow) setQuestionChoice(value => Math.max(0, value - 1));
      else if (key.downArrow || key.tab) setQuestionChoice(value => (value + 1) % (options.length + 1));
      else if (key.return) { const value = questionChoice < options.length ? options[questionChoice] : answerDraft.text.trim(); if (value) runtime.answer(value); }
      else if (key.backspace || key.delete) setAnswerDraft(value => deleteBackward(value));
      else if (input && !key.ctrl && !key.meta) { setQuestionChoice(options.length); setAnswerDraft(value => insertText(value, input)); }
      return;
    }
    if (overlay !== 'none') {
      if (key.escape) { open(overlay === 'form' || overlay === 'presets' ? 'profiles' : overlay === 'detail' ? 'tools' : 'none'); return; }
      if (overlay === 'form') {
        if (saving) return;
        if (key.tab) setFormFocus(value => (value + (key.shift ? formFields.length - 1 : 1)) % formFields.length);
        else if (key.ctrl && input === 'u') editFormText('', false, true);
        else if (key.leftArrow || key.rightArrow) {
          if (formFocus === 1) setForm(value => ({ ...value, protocol: protocolOptions[(protocolOptions.indexOf(value.protocol) + (key.rightArrow ? 1 : 2)) % 3]! }));
          if (formFocus === 8) setForm(value => ({ ...value, outputParameter: value.outputParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens' }));
        }
        else if (key.return) { if (formFocus === formFields.length - 1) void saveForm(); else setFormFocus(value => Math.min(formFields.length - 1, value + 1)); }
        else if (key.backspace || key.delete) editFormText('', true);
        else if (input && !key.ctrl && !key.meta) editFormText(input);
        return;
      }
      if (overlay === 'permission-confirm') {
        if (key.tab || key.leftArrow || key.rightArrow) setPermissionConfirmed(value => !value);
        if (key.return) { if (permissionConfirmed) invoke(() => runtime.setPermission(targetPermission)); open('none'); }
        return;
      }
      const count = overlay === 'profiles' || overlay === 'models' ? profileList.length + 3 : overlay === 'presets' ? presets.length : overlay === 'permissions' ? 3 : overlay === 'tools' ? Math.max(1, tools.length) : 1;
      if (key.upArrow) setSelected(value => Math.max(0, value - 1));
      else if (key.downArrow) setSelected(value => Math.min(count - 1, value + 1));
      else if (key.return) {
        if (overlay === 'profiles' || overlay === 'models') {
          const profile = profileList[selected];
          if (profile) { invoke(() => runtime.selectProfile(profile.id)); open('none'); }
          else if (selected === profileList.length) open('presets');
          else if (selected === profileList.length + 1) { setForm(createProfileForm(snapshot.profile)); setFormFocus(0); open('form'); }
          else { runtime.cancelPendingProfile(); open('none'); }
        } else if (overlay === 'presets') {
          const preset = presets[selected]; if (preset) { setForm({ ...createProfileForm(), ...preset }); setFormFocus(0); open('form'); }
        } else if (overlay === 'permissions') {
          const mode = (['ask', 'edit', 'full'] as const)[selected]!;
          if (mode !== 'ask' && (snapshot.permission === 'ask' || mode === 'full' && snapshot.permission !== 'full')) { setTargetPermission(mode); setPermissionConfirmed(false); open('permission-confirm'); }
          else { invoke(() => runtime.setPermission(mode)); open('none'); }
        } else if (overlay === 'tools') { const entry = tools[selected]; if (entry) { setDetailEntry(entry); open('detail'); } }
      } else if ((overlay === 'profiles' || overlay === 'models') && (key.backspace || key.delete)) { setFilter(value => graphemes(value).slice(0, -1).join('')); setSelected(0); }
      else if ((overlay === 'profiles' || overlay === 'models') && input && !key.ctrl && !key.meta) { setFilter(value => value + safeText(input)); setSelected(0); }
      else if (overlay === 'detail' && (key.rightArrow || key.leftArrow)) {
        const max = detailEntry ? toolDetailLines(detailEntry).reduce((width, line) => Math.max(width, stringWidth(line) - (bodyWidth - 4)), 0) : 0;
        setDetailOffset(value => Math.max(0, Math.min(max, value + (key.rightArrow ? 8 : -8))));
      }
      return;
    }
    if (key.pageUp) { setScrollTop(value => Math.max(0, (value ?? maxScroll) - Math.max(1, historyHeight - 1))); return; }
    if (key.pageDown) { setScrollTop(value => { const next = Math.min(maxScroll, (value ?? maxScroll) + Math.max(1, historyHeight - 1)); return next >= maxScroll ? null : next; }); return; }
    if (key.ctrl && key.end) { setScrollTop(null); return; }
    if (key.ctrl && input === 'j' || input === '\n') { setDraft(value => insertText(value, '\n')); return; }
    if (key.return) { submit(); return; }
    if (key.leftArrow) setDraft(value => moveCursor(value, -1));
    else if (key.rightArrow) setDraft(value => moveCursor(value, 1));
    else if (key.upArrow) setDraft(value => moveVertical(value, -1));
    else if (key.downArrow) setDraft(value => moveVertical(value, 1));
    else if (key.home) setDraft(value => lineBoundary(value, false));
    else if (key.end) setDraft(value => lineBoundary(value, true));
    else if (key.backspace) setDraft(value => deleteBackward(value));
    else if (key.delete) setDraft(value => deleteForward(value));
    else if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) setDraft(value => insertText(value, input));
  });

  const dialogRows = (): Row[] => {
    if (snapshot.approval) return [{ text: `执行确认：${snapshot.approval.title}`, color: theme.warning, bold: true }, ...wrapLines(snapshot.approval.details, bodyWidth - 4).map(text => ({ text })), { text: '批准仅作用于当前操作；Esc 拒绝。', color: theme.muted }];
    if (snapshot.question) return [{ text: 'ELVION 需要你的回答', color: theme.accent, bold: true }, ...wrapLines(snapshot.question.question, bodyWidth - 4).map(text => ({ text }))];
    if (overlay === 'help') return wrapLines('命令：/provider 供应商与模型；/model 当前供应商模型；/permissions 三种权限；/compact 压缩当前会话；/help 帮助；/exit 退出。\n快捷键：Enter 发送；Ctrl+J 换行；PgUp/PgDn 历史；Ctrl+End 回到底部；F2 工具详情；Ctrl+C 取消当前轮，空闲时退出。\n运行中普通消息仅作为草稿，不自动排队。Provider 与模型选择下轮生效。每次启动或恢复均回到每次询问。Esc 返回。', bodyWidth - 4).map(text => ({ text }));
    if (overlay === 'detail' && detailEntry) return [{ text: `${detailEntry.toolName} [${detailEntry.status ?? '未知'}] · 左右横移 ${detailOffset} 列 · PgUp/PgDn 纵向`, color: theme.accent }, ...toolDetailLines(detailEntry).map(text => ({ text: sliceColumns(text, detailOffset, bodyWidth - 4) }))];
    return [];
  };
  const renderDialog = () => {
    if (!hasDialog) return null;
    if (!hasRuntimeDialog && overlay === 'form') return <ConfigForm form={form} focused={formFocus} columns={columns} height={dialogHeight} error={formError} saving={saving} />;
    const content = dialogRows();
    const available = Math.max(1, dialogHeight - (snapshot.approval ? 5 : snapshot.question ? 6 + Math.min(4, snapshot.question.options?.length ?? 0) : 3));
    const start = Math.min(dialogScroll, Math.max(0, content.length - available));
    return <Box flexDirection="column" borderStyle="round" borderColor={snapshot.approval ? theme.warning : theme.accent} paddingX={1} height={dialogHeight} flexShrink={0} overflow="hidden">
      {content.slice(start, start + available).map((row, index) => <Text key={index} color={row.color ?? theme.text} bold={row.bold} wrap="truncate-end">{row.text || ' '}</Text>)}
      {content.length > available && <Text color={theme.muted}>PgUp/PgDn 查看全文（{start + 1}/{content.length}）</Text>}
      {snapshot.approval && <Box marginTop={1}><Text inverse={approvalChoice} color={theme.warning}>[批准一次]</Text><Text>  </Text><Text inverse={!approvalChoice} color={theme.text}>[拒绝]</Text></Box>}
      {snapshot.question && <><Text color={theme.muted}>方向键选择，输入文字可自由回答，Esc 取消。</Text>{(snapshot.question.options ?? []).slice(Math.max(0, questionChoice - 3), Math.max(0, questionChoice - 3) + 4).map((option, index) => { const optionIndex = Math.max(0, questionChoice - 3) + index; return <Text key={optionIndex} inverse={questionChoice === optionIndex} color={theme.text}>{truncate(`${questionChoice === optionIndex ? '> ' : '  '}${option}`, bodyWidth - 4)}</Text>; })}<Text inverse={questionChoice === (snapshot.question.options?.length ?? 0)} color={theme.text}>{truncate('自由回答：' + answerDraft.text, bodyWidth - 4)}</Text></>}
      {!hasRuntimeDialog && (overlay === 'profiles' || overlay === 'models') && <Selection title={overlay === 'profiles' ? '供应商与模型（输入文字过滤）' : '当前供应商模型'} hint={`筛选：${filter || '全部'}；Enter 选择；Esc 返回`} selected={selected} items={[...profileList.map(profile => `${profile.id === snapshot.profile?.id ? '[当前] ' : ''}${profile.name} / ${profile.model} (${profile.protocol})`), '+ 新建供应商／模型', '编辑当前模型配置', '撤销待切换模型']} width={bodyWidth - 4} height={dialogHeight - 2} />}
      {!hasRuntimeDialog && overlay === 'presets' && <Selection title="选择可编辑预设" hint="容量和最大输出必须按实际模型填写。Esc 返回。" selected={selected} items={presets.map(preset => preset.name)} width={bodyWidth - 4} height={dialogHeight - 2} />}
      {!hasRuntimeDialog && overlay === 'permissions' && <Selection title="权限模式（当前：" hint={`${permissionLabels[snapshot.permission]}）。提升权限需要再次确认。`} selected={selected} items={['每次询问：只读自动；文件修改及命令每次确认', '自动编辑：工作区文件自动；命令每次确认', '完全访问：自动执行本地操作，请确认工作区可信']} width={bodyWidth - 4} height={dialogHeight - 2} />}
      {!hasRuntimeDialog && overlay === 'permission-confirm' && <><Text color={theme.warning} bold>提升权限为：{permissionLabels[targetPermission]}</Text><Text color={theme.text}>后续操作将按新权限执行，已有修改不会回滚。确认当前项目可信。</Text><Box marginTop={1}><Text inverse={permissionConfirmed}>[确认提升]</Text><Text>  </Text><Text inverse={!permissionConfirmed}>[保持原权限]</Text></Box></>}
      {!hasRuntimeDialog && overlay === 'tools' && <Selection title="工具记录" hint="Enter 查看完整参数与输出；Esc 返回" selected={selected} items={tools.length ? tools.map(entry => `${entry.toolName} [${entry.status ?? '执行中'}] ${truncate(entry.content, 45)}`) : ['当前会话还没有工具记录']} width={bodyWidth - 4} height={dialogHeight - 2} />}
    </Box>;
  };

  if (tooSmall) return <Box flexDirection="column" width={Math.max(1, columns)} height={Math.max(1, rows)}><Text color={theme.warning}>窗口过小，请扩大至至少 60 列 × 18 行。</Text><Text color={theme.muted}>{truncate(`${statusLabels[snapshot.status]} | Ctrl+C ${isBusy ? '取消' : '退出'}`, Math.max(1, columns))}</Text></Box>;
  const commandHints = draft.text.startsWith('/') && !draft.text.includes('\n') ? commands.filter(command => command.startsWith(draft.text)).join('  ') : '';
  return <Box flexDirection="column" width={columns} height={rows} paddingX={2} backgroundColor={theme.background} overflow="hidden">
    <Box flexDirection="column" height={2} flexShrink={0}>
      <Text color={theme.text} bold>{truncate(`ELVION  会话 ${snapshot.sessionId.slice(0, 8)} | ${snapshot.title || '新会话'}${snapshot.restored ? ' [已恢复]' : ''}`, bodyWidth)}</Text>
      <Text color={theme.muted}>{truncate(`项目 ${snapshot.cwd} | ${statusLabels[snapshot.status] ?? snapshot.status}`, bodyWidth)}</Text>
    </Box>
    <Box height={historyHeight} flexShrink={0} flexDirection="column" overflow="hidden">
      {todoHeight > 0 && <Box flexDirection="column" height={todoHeight} flexShrink={0}>{snapshot.todos.slice(0, todoHeight).map((todo, index) => <Text key={index} color={todo.status === 'in_progress' ? theme.accent : theme.muted} wrap="truncate-end">{truncate(`${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]'} ${todo.text}${index === todoHeight - 1 && snapshot.todos.length > todoHeight ? ` （另 ${snapshot.todos.length - todoHeight} 项，F2 查看 todo 记录）` : ''}`, bodyWidth)}</Text>)}</Box>}
      {welcome && !hasDialog && !todoHeight ? <Welcome columns={columns} rows={rows} bashAvailable={bash.available} bashError={bash.error} providerConfigured={!!snapshot.profile} /> : visibleRows.map((row, index) => <Text key={historyStart + index} color={row.color} bold={row.bold} wrap="truncate-end">{row.segments ? row.segments.map((segment, part) => <Text key={part} bold={row.bold || segment.bold} color={segment.code ? theme.accent : row.color}>{segment.text}</Text>) : row.text || ' '}</Text>)}
    </Box>
    {renderDialog()}
    {notice && <Text color={theme.warning} wrap="truncate-end">{notice}</Text>}
    <Text color={theme.border}>{'─'.repeat(bodyWidth)}</Text>
    <Box flexDirection="column" height={inputHeight} flexShrink={0} aria-role="textbox" aria-label="任务输入" aria-state={{ multiline: true }}>
      {Array.from({ length: inputHeight }, (_, index) => <Text key={index} color={draft.text ? theme.text : theme.muted} wrap="truncate-end">{index === 0 ? '> ' : '  '}{inputLines[inputStart + index] || (index === 0 && !draft.text ? '描述你想完成的任务…' : ' ')}</Text>)}
    </Box>
    <Text color={theme.border}>{'─'.repeat(bodyWidth)}</Text>
    <Box flexDirection="column" height={2} flexShrink={0}>
      <Text color={snapshot.permission === 'full' || snapshot.contextPercent >= 75 ? theme.warning : theme.muted} wrap="truncate-end">{truncate(`${permissionLabels[snapshot.permission]} | 上下文 ${Math.round(snapshot.contextPercent)}%${snapshot.estimated ? '（估算）' : ''} | ${statusLabels[snapshot.status]} | ${snapshot.profile ? snapshot.profile.name + ' / ' + snapshot.profile.model : 'Provider 未配置'}`, bodyWidth)}</Text>
      <Text color={theme.muted} wrap="truncate-end">{truncate(snapshot.pendingProfile ? `待切换：${snapshot.pendingProfile.name} / ${snapshot.pendingProfile.model}，当前轮结束后生效` : scrollTop !== null && historyStart < maxScroll ? '有新内容，Ctrl+End 回到底部' : snapshot.compactPending ? '将在安全边界压缩上下文' : commandHints || 'Enter 发送 | Ctrl+J 换行 | PgUp/PgDn 历史 | F2 详情 | Ctrl+C 取消/退出', bodyWidth)}</Text>
    </Box>
  </Box>;
}

function Selection({ title, hint, selected, items, width, height }: { title: string; hint: string; selected: number; items: string[]; width: number; height: number }): React.JSX.Element {
  const available = Math.max(1, height - 3); const start = Math.max(0, Math.min(selected - available + 1, items.length - available));
  return <Box flexDirection="column"><Text bold color={theme.accent}>{truncate(title, width)}</Text><Text color={theme.muted}>{truncate(hint, width)}</Text>{items.slice(start, start + available).map((item, index) => <Text key={index} inverse={start + index === selected} color={theme.text}>{truncate(`${start + index === selected ? '> ' : '  '}${item}`, width)}</Text>)}</Box>;
}
