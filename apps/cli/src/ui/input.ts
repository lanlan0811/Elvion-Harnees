import { cleanText, graphemes } from './text.js';
import type { SlashCommand } from './types.js';

export interface InputState { value: string; cursor: number }
export interface InputKey {
  ctrl?: boolean; meta?: boolean; shift?: boolean; return?: boolean; escape?: boolean;
  backspace?: boolean; delete?: boolean; leftArrow?: boolean; rightArrow?: boolean;
  upArrow?: boolean; downArrow?: boolean; home?: boolean; end?: boolean; pageUp?: boolean; pageDown?: boolean;
}
export type InputEffect = 'none' | 'submit' | 'interrupt' | 'escape' | 'scroll-up' | 'scroll-down';
export interface InputTransition { state: InputState; effect: InputEffect }
export const MAX_INPUT_CHARACTERS = 64_000;
export const SLASH_COMMANDS = ['provider', 'model', 'permissions', 'sessions', 'resume', 'new', 'help'] as const;

export function parseSubmission(value: string): { type: 'message'; text: string } | { type: 'command'; command: SlashCommand; args: string } | { type: 'unknown-command'; command: string } | { type: 'empty' } {
  const text = value.trim();
  if (!text) return { type: 'empty' };
  if (!text.startsWith('/')) return { type: 'message', text };
  const firstSpace = text.search(/\s/u);
  const name = text.slice(1, firstSpace < 0 ? undefined : firstSpace);
  if (!SLASH_COMMANDS.some(command => command === name)) return { type: 'unknown-command', command: name };
  return { type: 'command', command: name as SlashCommand, args: firstSpace < 0 ? '' : text.slice(firstSpace).trim() };
}

/** Pure key processing also covers input received in a single multi-line paste. */
export function transitionInput(state: InputState, input: string, key: InputKey): InputTransition {
  const parts = graphemes(state.value);
  const cursor = Math.max(0, Math.min(parts.length, state.cursor));
  const result = (value = parts.join(''), next = cursor, effect: InputEffect = 'none'): InputTransition => ({ state: { value, cursor: next }, effect });
  if (key.ctrl && input.toLowerCase() === 'c') return result(undefined, undefined, 'interrupt');
  if (key.escape) return result(undefined, undefined, 'escape');
  if (key.pageUp || (key.ctrl && key.upArrow)) return result(undefined, undefined, 'scroll-up');
  if (key.pageDown || (key.ctrl && key.downArrow)) return result(undefined, undefined, 'scroll-down');
  if (key.leftArrow) return result(undefined, Math.max(0, cursor - 1));
  if (key.rightArrow) return result(undefined, Math.min(parts.length, cursor + 1));
  if (key.home || (key.ctrl && input === 'a')) return result(undefined, 0);
  if (key.end || (key.ctrl && input === 'e')) return result(undefined, parts.length);
  if (key.backspace) { if (cursor > 0) parts.splice(cursor - 1, 1); return result(parts.join(''), Math.max(0, cursor - 1)); }
  if (key.delete) { parts.splice(cursor, 1); return result(parts.join('')); }
  const newline = (key.ctrl && input.toLowerCase() === 'j') || (input === '\n' && !key.return);
  if (key.return && !newline && !input.includes('\n')) return result(undefined, undefined, 'submit');
  if (key.ctrl || key.meta || key.upArrow || key.downArrow) {
    if (!newline) return result();
  }
  const insertion = newline ? ['\n'] : graphemes(cleanText(input));
  parts.splice(cursor, 0, ...insertion.slice(0, Math.max(0, MAX_INPUT_CHARACTERS - parts.length)));
  return result(parts.join(''), Math.min(MAX_INPUT_CHARACTERS, cursor + insertion.length));
}
