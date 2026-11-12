import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
export const graphemes = (value: string): string[] => Array.from(segmenter.segment(value), part => part.segment);
export function safeText(value: string): string {
  // Strip hostile terminal controls; tabs and line feeds remain valid text.
  return stripAnsi(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
}
export interface EditorState { text: string; cursor: number }
export function insertText(state: EditorState, input: string): EditorState {
  const chars = graphemes(state.text); const clean = safeText(input);
  chars.splice(state.cursor, 0, clean);
  return { text: chars.join(''), cursor: state.cursor + graphemes(clean).length };
}
export function deleteBackward(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const chars = graphemes(state.text); chars.splice(state.cursor - 1, 1);
  return { text: chars.join(''), cursor: state.cursor - 1 };
}
export function deleteForward(state: EditorState): EditorState {
  const chars = graphemes(state.text); chars.splice(state.cursor, 1);
  return { text: chars.join(''), cursor: state.cursor };
}
export function moveCursor(state: EditorState, delta: number): EditorState {
  return { ...state, cursor: Math.max(0, Math.min(graphemes(state.text).length, state.cursor + delta)) };
}
export function lineBoundary(state: EditorState, end: boolean): EditorState {
  const chars = graphemes(state.text); let cursor = state.cursor;
  if (end) { while (cursor < chars.length && chars[cursor] !== '\n') cursor++; }
  else { while (cursor > 0 && chars[cursor - 1] !== '\n') cursor--; }
  return { ...state, cursor };
}
export function moveVertical(state: EditorState, delta: -1 | 1): EditorState {
  const chars = graphemes(state.text); const before = chars.slice(0, state.cursor).join('');
  const currentLine = before.split('\n').length - 1;
  const lines = state.text.split('\n'); const targetLine = currentLine + delta;
  if (targetLine < 0 || targetLine >= lines.length) return state;
  const desired = stringWidth(before.split('\n').at(-1) ?? '');
  const target = graphemes(lines[targetLine] ?? ''); let offset = 0; let cells = 0;
  for (const char of target) { if (cells + stringWidth(char) > desired) break; cells += stringWidth(char); offset++; }
  const prefix = lines.slice(0, targetLine).join('\n');
  return { ...state, cursor: graphemes(prefix).length + (targetLine ? 1 : 0) + offset };
}
export function wrapLines(text: string, width: number): string[] {
  const limit = Math.max(1, width); const lines: string[] = [];
  for (const logical of safeText(text).split('\n')) {
    let line = ''; let cells = 0;
    for (const char of graphemes(logical)) {
      const size = stringWidth(char);
      if (cells + size > limit && line) { lines.push(line); line = ''; cells = 0; }
      line += char; cells += size;
    }
    lines.push(line);
  }
  return lines;
}
export function truncate(value: string, width: number): string {
  value = safeText(value);
  if (stringWidth(value) <= width) return value;
  let result = ''; for (const char of graphemes(value)) { if (stringWidth(result + char) > Math.max(0, width - 1)) break; result += char; }
  return result + '…';
}
export function sliceColumns(value: string, offset: number, width: number): string {
  let column = 0; let result = ''; let used = 0;
  for (const char of graphemes(safeText(value))) {
    const size = stringWidth(char);
    if (column < offset) { if (column + size > offset) { result += ' '; used++; } column += size; continue; }
    if (used + size > width) break;
    result += char; used += size; column += size;
  }
  return result;
}
export function cursorPosition(state: EditorState, width: number): { x: number; y: number } {
  const before = graphemes(state.text).slice(0, state.cursor).join('');
  const lines = wrapLines(before, width);
  const lastWidth = stringWidth(lines.at(-1) ?? '');
  return lastWidth === width ? { x: 0, y: lines.length } : { x: lastWidth, y: lines.length - 1 };
}
