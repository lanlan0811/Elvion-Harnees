import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function cleanText(value: string): string {
  const text = stripVTControlCharacters(value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  return Array.from(text).filter(character => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
  }).join('').replaceAll('\t', '  ');
}
export function graphemes(value: string): string[] { return Array.from(segmenter.segment(value), part => part.segment); }
export function cellWidth(value: string): number { return stringWidth(value); }
export function truncate(value: string, columns: number): string {
  let result = '';
  let width = 0;
  for (const part of graphemes(cleanText(value))) {
    if (part === '\n') break;
    const size = cellWidth(part);
    if (width + size > columns) break;
    result += part; width += size;
  }
  return result;
}
export function pad(value: string, columns: number): string {
  const text = truncate(value, columns);
  return text + ' '.repeat(Math.max(0, columns - cellWidth(text)));
}
export function wrapText(value: string, columns: number): string[] {
  if (columns < 1) return [];
  const result: string[] = [];
  for (const source of cleanText(value).split('\n')) {
    let line = '';
    let width = 0;
    for (const part of graphemes(source)) {
      const size = cellWidth(part);
      if (width + size > columns && line) { result.push(line); line = ''; width = 0; }
      if (size > columns) continue;
      line += part; width += size;
    }
    result.push(line);
  }
  return result;
}
