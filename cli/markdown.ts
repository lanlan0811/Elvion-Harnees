import stringWidth from 'string-width';
import { graphemes, safeText, wrapLines } from './editor.js';

export interface MarkdownSegment { text: string; bold?: boolean; code?: boolean }
export interface MarkdownRow { text: string; bold?: boolean; code?: boolean; segments?: MarkdownSegment[] }
export function inlineMarkdown(value: string): MarkdownSegment[] {
  const parts: MarkdownSegment[] = []; const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let previous = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > previous) parts.push({ text: value.slice(previous, match.index) });
    if (match[1] || match[2]) parts.push({ text: (match[1] || match[2])!, bold: true });
    else if (match[3]) parts.push({ text: match[3], code: true });
    else parts.push({ text: `${match[4]} (${match[5]})` });
    previous = match.index + match[0].length;
  }
  if (previous < value.length || !parts.length) parts.push({ text: value.slice(previous) });
  return parts;
}
function wrappedInline(text: string, width: number, bold = false): MarkdownRow[] {
  const rows: MarkdownRow[] = []; let segments: MarkdownSegment[] = []; let used = 0;
  const flush = () => { rows.push({ text: segments.map(segment => segment.text).join(''), bold, segments }); segments = []; used = 0; };
  for (const part of inlineMarkdown(text)) for (const char of graphemes(part.text)) {
    const size = stringWidth(char); if (used + size > width && used) flush();
    const last = segments.at(-1);
    if (last && last.bold === part.bold && last.code === part.code) last.text += char;
    else segments.push({ ...part, text: char });
    used += size;
  }
  flush(); return rows;
}
export function markdownRows(value: string, width: number): MarkdownRow[] {
  const lines = safeText(value).split('\n'); const result: MarkdownRow[] = []; let code = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) { code = !code; if (code) result.push({ text: '代码 ' + line.trim().slice(3), code: true }); continue; }
    if (code) { result.push(...wrapLines('  ' + line, width).map(text => ({ text, code: true }))); continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '')) {
      const table: string[][] = []; const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => inlineMarkdown(cell.trim()).map(part => part.text).join(''));
      table.push(cells(line)); index += 2;
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) { table.push(cells(lines[index]!)); index++; }
      index--; const count = Math.max(...table.map(row => row.length));
      const widths = Array.from({ length: count }, (_, col) => Math.max(1, ...table.map(row => stringWidth(row[col] ?? ''))));
      for (let row = 0; row < table.length; row++) {
        const text = table[row]!.map((cell, col) => cell + ' '.repeat(Math.max(0, widths[col]! - stringWidth(cell)))).join(' | ');
        result.push(...wrapLines(text, width).map(text => ({ text, bold: row === 0 })));
        if (row === 0) result.push(...wrapLines(widths.map(size => '─'.repeat(size)).join('─┼─'), width).map(text => ({ text })));
      }
      continue;
    }
    const heading = /^#{1,6}\s+/.test(line);
    const text = heading ? line.replace(/^#{1,6}\s+/, '') : line.replace(/^(\s*)[-*+]\s+/, '$1- ');
    result.push(...wrappedInline(text, width, heading));
  }
  return result;
}
