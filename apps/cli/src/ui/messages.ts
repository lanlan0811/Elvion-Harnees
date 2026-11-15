import { cleanText, wrapText } from './text.js';
import type { FrameLine, Tone } from './layout.js';
import type { UiMessage } from './types.js';

function messageTone(message: UiMessage): Tone {
  if (message.kind === 'error') return 'error';
  if (message.kind === 'user') return 'brand';
  if (message.kind === 'system') return 'muted';
  if (message.kind === 'task') return message.status === 'completed' ? 'ok' : message.status === 'failed' ? 'error' : 'brand';
  if (message.kind === 'usage') return 'muted';
  return 'text';
}
export function messageLines(messages: readonly UiMessage[], columns: number): FrameLine[] {
  const width = Math.max(1, columns);
  const lines: FrameLine[] = [];
  for (const message of messages) {
    const heading = cleanText(`${message.title ?? message.kind}${message.status ? ` · ${message.status}` : ''}`);
    for (const line of wrapText(heading, width)) lines.push({ parts: [{ text: line, tone: messageTone(message) }] });
    for (const line of wrapText(message.text, width)) {
      let tone = messageTone(message);
      if (message.kind === 'diff') tone = line.startsWith('+') && !line.startsWith('+++') ? 'ok' : line.startsWith('-') && !line.startsWith('---') ? 'error' : 'muted';
      lines.push({ parts: [{ text: line, tone }] });
    }
    lines.push({ parts: [{ text: '' }] });
  }
  return lines;
}
export function messageViewport(messages: readonly UiMessage[], columns: number, rows: number, scrollOffset: number): { lines: FrameLine[]; offset: number; hiddenAbove: number; totalLines: number } {
  const all = messageLines(messages, columns);
  const height = Math.max(0, rows);
  const offset = Math.min(Math.max(0, scrollOffset), Math.max(0, all.length - height));
  const end = Math.max(0, all.length - offset);
  const start = Math.max(0, end - height);
  return { lines: all.slice(start, end), offset, hiddenAbove: start, totalLines: all.length };
}
