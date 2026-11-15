import { brandLines } from './brand.js';
import { cellWidth, pad, truncate, wrapText } from './text.js';
import type { BrandAssets, HealthStatus, UiHealth } from './types.js';

export type Layout = 'large' | 'small' | 'wordmark' | 'compact';
export type Tone = 'text' | 'muted' | 'brand' | 'ok' | 'warning' | 'error';
export interface StyledPart { text: string; tone?: Tone }
export interface FrameLine { parts: StyledPart[]; gradient?: boolean }
export interface WelcomeOptions { columns: number; rows: number; assets: BrandAssets; health: UiHealth; version: string }
export const PALETTE = { background: '#030b14', text: '#a6bcee', muted: '#607dab', brand: '#70cfff', ok: '#50e8ac', warning: '#e2bb6b', error: '#ff7c8e' } as const;

export function selectLayout(columns: number, rows: number): Layout {
  if (columns >= 144 && rows >= 36) return 'large';
  if (columns >= 116 && rows >= 28) return 'small';
  return columns >= 72 ? 'wordmark' : 'compact';
}
export function frameToText(lines: readonly FrameLine[]): string[] { return lines.map(line => line.parts.map(part => part.text).join('')); }
function text(value = '', tone: Tone = 'text'): FrameLine { return { parts: [{ text: value, tone }] }; }
function width(line: FrameLine): number { return line.parts.reduce((size, part) => size + cellWidth(part.text), 0); }
function fit(line: FrameLine, columns: number): FrameLine {
  let remaining = columns;
  const parts = line.parts.map(part => { const value = truncate(part.text, remaining); remaining -= cellWidth(value); return { ...part, text: value }; });
  return { ...line, parts };
}
function statusTone(status: HealthStatus): Tone { return status.state === 'pending' ? 'muted' : status.state; }
function healthCard(columns: number, health: UiHealth): FrameLine[] {
  const inner = Math.max(1, columns - 2);
  const lines: FrameLine[] = [text('┌' + '─'.repeat(inner) + '┐', 'brand')];
  const entries = [['◇', 'Runtime', health.runtime], ['>', 'Execution', health.execution], ['+', 'Tools', health.tools]] as const;
  for (const [symbol, label, status] of entries) {
    const left = truncate(` ${symbol}  ${label}`, Math.floor(inner / 2));
    const right = truncate(`${status.state === 'ok' ? '●' : status.state === 'pending' ? '·' : '!'} ${status.label}`, Math.max(1, inner - cellWidth(left) - 2));
    lines.push({ parts: [{ text: '│', tone: 'brand' }, { text: left + ' '.repeat(Math.max(1, inner - cellWidth(left) - cellWidth(right) - 1)) }, { text: right, tone: statusTone(status) }, { text: ' │', tone: 'brand' }] });
  }
  lines.push(text('├' + '─'.repeat(inner) + '┤', 'brand'));
  lines.push(text('│' + pad(' ✦ Let’s turn your ideas into reality. →', inner) + '│'));
  lines.push(text('└' + '─'.repeat(inner) + '┘', 'brand'));
  return lines;
}

/** A cell grid is also the testable source of the live Ink welcome panel. */
export function buildWelcomeFrame(options: WelcomeOptions): FrameLine[] {
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(0, Math.floor(options.rows) - 8);
  if (rows === 0) return [];
  const layout = selectLayout(columns, options.rows);
  const margin = columns >= 72 ? 2 : 1;
  const available = Math.max(1, columns - margin * 2);
  let body: FrameLine[];
  if (layout === 'compact' || rows < 16) {
    body = [text(`ELVION  v${options.version}`, 'brand'), text('Your Partner in Action.'), text()];
    for (const [name, status] of [['Runtime', options.health.runtime], ['Execution', options.health.execution], ['Tools', options.health.tools]] as const) {
      for (const line of wrapText(`${name}: ${status.label}`, available)) body.push(text(line, statusTone(status)));
    }
    body.push(text(), text('Type /help for commands.', 'muted'));
  } else {
    const fox = layout === 'large' ? brandLines(options.assets.largeFox) : layout === 'small' ? brandLines(options.assets.smallFox) : [];
    const foxWidth = fox.length ? Math.max(...fox.map(cellWidth)) : 0;
    const gap = fox.length ? 4 : 0;
    const rightWidth = available - foxWidth - gap;
    const wordmark = brandLines(options.assets.wordmark).map(value => ({ ...text(value, 'brand'), gradient: true }));
    const right = [...wordmark, text(), text('Your Partner in Action.'), text(), ...healthCard(rightWidth, options.health)];
    if (fox.length === 0) {
      body = right;
      if (body.length > rows) body = [...wordmark, text('Your Partner in Action.'), ...healthCard(rightWidth, options.health)];
    } else {
      const rightOffset = Math.max(0, Math.floor((fox.length - right.length) / 2));
      body = Array.from({ length: Math.max(fox.length, right.length + rightOffset) }, (_, index) => {
        const left = fox[index] ?? '';
        const rightLine = right[index - rightOffset] ?? text();
        return { parts: [{ text: pad(left, foxWidth), tone: 'brand' }, { text: ' '.repeat(gap) }, ...rightLine.parts], gradient: true };
      });
    }
  }
  const offset = Math.max(0, Math.floor((rows - body.length) / 2));
  const result: FrameLine[] = Array.from({ length: rows }, () => text());
  for (let index = 0; index < Math.min(body.length, rows); index++) {
    const line = body[index];
    if (line) result[index + offset] = fit({ ...line, parts: [{ text: ' '.repeat(margin) }, ...line.parts] }, columns);
  }
  return result;
}
export function gradientColor(position: number, total: number): string {
  const stops = [[112, 220, 255], [111, 160, 244], [161, 141, 255]] as const;
  const t = Math.min(1, Math.max(0, total <= 1 ? 0 : position / (total - 1))) * 2;
  const index = t >= 1 ? 1 : 0;
  const first = stops[index]; const second = stops[index + 1];
  if (!first || !second) return PALETTE.brand;
  return '#' + first.map((value, component) => Math.round(value + ((second[component] ?? value) - value) * (t - index)).toString(16).padStart(2, '0')).join('');
}
export function noColor(environment: NodeJS.ProcessEnv = process.env): boolean { return environment.NO_COLOR !== undefined || environment.TERM === 'dumb'; }
export function centerLine(line: FrameLine, columns: number): FrameLine { return { ...line, parts: [{ text: ' '.repeat(Math.max(0, Math.floor((columns - width(line)) / 2))) }, ...line.parts] }; }
