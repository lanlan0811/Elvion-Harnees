import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { buildWelcomeFrame, gradientColor, noColor, PALETTE } from './layout.js';
import type { FrameLine, Tone } from './layout.js';
import { messageViewport } from './messages.js';
import { parseSubmission, transitionInput } from './input.js';
import type { InputState } from './input.js';
import { cellWidth, cleanText, graphemes, pad, truncate, wrapText } from './text.js';
import type { ElvionAppProps, UiApproval } from './types.js';

const permissionLabels = { ask: '每次询问', 'auto-edit': '自动编辑', 'full-access': '完全访问' } as const;
function line(text = '', tone: Tone = 'text'): FrameLine { return { parts: [{ text, tone }] }; }

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({ columns: Math.max(1, stdout.columns || 80), rows: Math.max(1, stdout.rows || 24) });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = () => setSize(read());
    stdout.on('resize', resize);
    stdout.write('\u001b[?2004h');
    return () => { stdout.off('resize', resize); stdout.write('\u001b[?2004l'); };
  }, [stdout]);
  return size;
}

export function approvalLines(approval: UiApproval, columns: number): FrameLine[] {
  const header = [line('批准当前工具调用', 'warning'), line(`请求: ${approval.id}`, 'muted'), line(`工具: ${approval.tool}`, 'brand'), line(`目录: ${approval.cwd}`), line(`范围: ${approval.scope}`), line('参数:')];
  let parameters: string;
  try {
    parameters = JSON.stringify(approval.arguments, (key: string, value: unknown) => /(?:api.?key|token|secret|password|authorization)/iu.test(key) ? '[REDACTED]' : value, 2) ?? 'null';
  } catch { parameters = '[无法显示参数]'; }
  const details = [...header, ...wrapText(parameters.slice(0, 16_000), columns).map(value => line(value, 'muted')), line(), line('[Y] 仅批准本次    [N / Esc] 拒绝', 'warning')];
  return details.flatMap(item => wrapText(item.parts.map(part => part.text).join(''), columns).map(text => ({ parts: [{ text, tone: item.parts[0]?.tone ?? 'text' }] })));
}

export function inputLines(state: InputState, columns: number, height = 3): FrameLine[] {
  const contentWidth = Math.max(1, columns - 2);
  const characters = graphemes(state.value);
  characters.splice(state.cursor, 0, '▌');
  const wrapped = wrapText(characters.join(''), contentWidth);
  const cursorLine = Math.max(0, wrapped.findIndex(value => value.includes('▌')));
  const start = Math.max(0, cursorLine - height + 1);
  return Array.from({ length: height }, (_, index) => line(truncate(`${index === 0 ? '› ' : '  '}${wrapped[start + index] ?? ''}`, columns), index === 0 ? 'brand' : 'text'));
}

function RenderLine({ value, columns, color }: { value: FrameLine; columns: number; color: boolean }) {
  const content = value.parts.map(part => part.text).join('');
  return <Text wrap='truncate' {...(color ? { backgroundColor: PALETTE.background, color: PALETTE.text } : {})}>
    {value.parts.map((part, index) => {
      if (color && value.gradient && part.tone === 'brand') return <Text key={index}>{graphemes(part.text).map((character, characterIndex, characters) => <Text key={characterIndex} color={gradientColor(characterIndex, characters.length)}>{character}</Text>)}</Text>;
      return <Text key={index} {...(color ? { color: PALETTE[part.tone ?? 'text'] } : {})}>{part.text}</Text>;
    })}
    {' '.repeat(Math.max(0, columns - cellWidth(content)))}
  </Text>;
}

export function ElvionApp(props: ElvionAppProps) {
  const { exit } = useApp();
  const size = useTerminalSize();
  const color = !noColor();
  const [input, setInput] = useState<InputState>({ value: '', cursor: 0 });
  const inputRef = useRef(input);
  const pasteRef = useRef(false);
  const approvedRef = useRef<string | undefined>(undefined);
  const [scroll, setScroll] = useState(0);
  const [localError, setLocalError] = useState('');
  const [approvalSent, setApprovalSent] = useState<string>();
  const [approvalScroll, setApprovalScroll] = useState(0);
  const bodyHeight = Math.max(0, size.rows - 8);
  const hasConversation = props.messages.length > 0;
  const viewport = useMemo(() => messageViewport(props.messages, size.columns, bodyHeight, scroll), [props.messages, size.columns, bodyHeight, scroll]);
  useEffect(() => { approvedRef.current = undefined; setApprovalSent(undefined); setApprovalScroll(0); }, [props.approval?.id]);
  useEffect(() => { if (!props.busy) setScroll(0); }, [props.busy]);

  useInput((value, key) => {
    if (value === '[200~') { pasteRef.current = true; return; }
    if (value === '[201~') { pasteRef.current = false; return; }
    const next = transitionInput(inputRef.current, value, pasteRef.current ? {} : key);
    if (next.effect === 'interrupt') {
      if (props.approval && approvedRef.current !== props.approval.id) { approvedRef.current = props.approval.id; setApprovalSent(props.approval.id); props.onApproval(props.approval.id, false); }
      if (props.busy) props.onCancel(); else { props.onExit?.(); exit(); }
      return;
    }
    if (props.approval) {
      if (pasteRef.current || approvedRef.current === props.approval.id) return;
      if (key.pageUp || key.upArrow) { setApprovalScroll(current => Math.max(0, current - 1)); return; }
      if (key.pageDown || key.downArrow) { setApprovalScroll(current => current + 1); return; }
      if (key.escape || value.toLowerCase() === 'n' || value.toLowerCase() === 'y') {
        approvedRef.current = props.approval.id; setApprovalSent(props.approval.id);
        props.onApproval(props.approval.id, !key.escape && value.toLowerCase() === 'y');
      }
      return;
    }
    if (next.effect === 'escape') { props.onCloseOverlay?.(); setLocalError(''); return; }
    if (props.overlay) return;
    if (next.effect === 'scroll-up') { setScroll(current => current + Math.max(1, bodyHeight - 1)); return; }
    if (next.effect === 'scroll-down') { setScroll(current => Math.max(0, current - Math.max(1, bodyHeight - 1))); return; }
    if (next.effect !== 'submit') { inputRef.current = next.state; setInput(next.state); return; }
    const submission = parseSubmission(inputRef.current.value);
    if (submission.type === 'empty') return;
    if (props.busy) { setLocalError('执行中；Ctrl+C 取消当前执行。'); return; }
    if (submission.type === 'unknown-command') { setLocalError(`未知命令 /${submission.command}，输入 /help 查看命令。`); return; }
    inputRef.current = { value: '', cursor: 0 }; setInput(inputRef.current); setLocalError(''); setScroll(0);
    void Promise.resolve().then(() => submission.type === 'message' ? props.onSubmit(submission.text) : props.onCommand(submission.command, submission.args))
      .catch(error => setLocalError(cleanText(error instanceof Error ? error.message : String(error))));
  });

  let body: FrameLine[];
  if (props.approval) {
    const all = approvalLines(props.approval, size.columns);
    const start = Math.min(approvalScroll, Math.max(0, all.length - Math.max(0, bodyHeight - 1)));
    body = all.slice(start, start + Math.max(0, bodyHeight - 1));
    if (bodyHeight > 0) body.push(line(approvalSent ? '正在记录审批结果…' : '[Y] 仅批准本次  [N / Esc] 拒绝  [↑ ↓] 查看参数', 'warning'));
  } else if (props.overlay) {
    body = [line(props.overlay.title, 'brand'), ...props.overlay.lines.flatMap(value => wrapText(value, size.columns).map(value => line(value))), line('Esc 返回', 'muted')].slice(0, bodyHeight);
  } else if (hasConversation) { body = viewport.lines; }
  else { body = buildWelcomeFrame({ ...size, assets: props.assets, health: props.health, version: props.version }); }
  while (body.length < bodyHeight) body.push(line());
  const header = hasConversation ? `ELVION · ${props.busy ? '执行中' : '就绪'}` : '';
  const version = `ELVION CLI v${props.version}`;
  const headerText = pad(header, Math.max(0, size.columns - cellWidth(version))) + truncate(version, size.columns);
  const status = `${permissionLabels[props.permissionMode]} | ${props.model ?? '未配置模型'} | ${props.workspace}`;
  const footer = localError || (viewport.offset > 0 ? `历史记录 · 距底部 ${viewport.offset} 行 · PgDn 向下` : 'Enter 发送 · Ctrl+J 换行 · PgUp/PgDn 滚动 · /help');
  const frame = [line(truncate(headerText, size.columns), 'muted'), line(), ...body, line('─'.repeat(size.columns), 'muted'), ...inputLines(input, size.columns), line(truncate(footer, size.columns), localError ? 'error' : 'muted'), line(truncate(status, size.columns), props.permissionMode === 'full-access' ? 'warning' : 'muted')];
  return <Box width={size.columns} height={size.rows} flexDirection='column' overflow='hidden'>{frame.slice(0, size.rows).map((value, index) => <RenderLine key={index} value={value} columns={size.columns} color={color} />)}</Box>;
}
