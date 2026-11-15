import { ElvionError } from '@elvion/kernel';

export interface PatchTarget { path: string; create: boolean; delete: boolean; hunks: Hunk[] }
interface PatchLine { kind: ' ' | '+' | '-'; text: string; noNewline: boolean }
interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: PatchLine[] }
const invalid = (message: string): never => { throw new ElvionError('validation_error', `Invalid unified diff: ${message}`); };
function fileName(line: string, prefix: string): string {
  let name = line.slice(prefix.length).split('\t')[0] ?? '';
  if (name === '/dev/null') return name;
  if (name.startsWith('a/') || name.startsWith('b/')) name = name.slice(2);
  if (!name || /[\\\0]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || name.charCodeAt(0) === 34) invalid('file paths must be unquoted relative paths without traversal');
  return name;
}

export function parsePatch(patch: string): PatchTarget[] {
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const targets: PatchTarget[] = []; let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (line.startsWith('diff --git ') || line.startsWith('index ') || /^(new|deleted) file mode /.test(line)) { cursor++; continue; }
    if (!line.startsWith('--- ')) invalid('expected --- file header');
    const oldPath = fileName(line, '--- ');
    const next = lines[++cursor] ?? '';
    if (!next.startsWith('+++ ')) invalid('expected +++ file header');
    const newPath = fileName(next, '+++ '); cursor++;
    if (oldPath === '/dev/null' && newPath === '/dev/null') invalid('both file paths are null');
    if (oldPath !== newPath && oldPath !== '/dev/null' && newPath !== '/dev/null') invalid('renames are unsupported');
    const target: PatchTarget = { path: newPath === '/dev/null' ? oldPath : newPath, create: oldPath === '/dev/null', delete: newPath === '/dev/null', hunks: [] };
    while (cursor < lines.length && (lines[cursor] ?? '').startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[cursor] ?? '');
      if (!match) invalid('malformed hunk header');
      const validMatch = match!;
      const hunk: Hunk = { oldStart: Number(validMatch[1]), oldCount: Number(validMatch[2] ?? 1), newStart: Number(validMatch[3]), newCount: Number(validMatch[4] ?? 1), lines: [] }; cursor++;
      let oldCount = 0; let newCount = 0;
      while (cursor < lines.length && (oldCount < hunk.oldCount || newCount < hunk.newCount)) {
        const data = lines[cursor] ?? ''; const kind = data[0];
        if (kind !== ' ' && kind !== '+' && kind !== '-') invalid('hunk lines need a context/add/delete prefix');
        hunk.lines.push({ kind: kind as PatchLine['kind'], text: data.slice(1), noNewline: false });
        if (kind !== '+') oldCount++; if (kind !== '-') newCount++; cursor++;
        if ((lines[cursor] ?? '') === '\\ No newline at end of file') { hunk.lines[hunk.lines.length - 1]!.noNewline = true; cursor++; }
      }
      if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) invalid('hunk line counts do not match');
      target.hunks.push(hunk);
    }
    if (!target.hunks.length) invalid('file has no hunks');
    if (targets.some(item => item.path === target.path)) invalid('duplicate target file');
    targets.push(target);
  }
  if (!targets.length) invalid('no files');
  return targets;
}

export function applyHunks(original: string, target: PatchTarget): string {
  if (original.includes('\r\n') && original.replaceAll('\r\n', '').includes('\n')) invalid('mixed line endings require an exact edit instead');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const endsNewline = original.endsWith('\n');
  const source = original === '' ? [] : original.replaceAll('\r\n', '\n').split('\n');
  if (endsNewline) source.pop();
  const output: string[] = []; let cursor = 0; let finalNewline = endsNewline;
  for (const hunk of target.hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > source.length) invalid('hunk is out of order or beyond the file');
    output.push(...source.slice(cursor, start)); cursor = start;
    if (output.length !== (hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1)) invalid('new hunk offset does not match');
    for (const line of hunk.lines) {
      if (line.kind !== '+') {
        if (source[cursor] !== line.text) invalid('context does not match the file');
        if (line.noNewline && cursor !== source.length - 1) invalid('old final newline marker is not at end of file');
        if (cursor === source.length - 1 && endsNewline === line.noNewline) invalid('old final newline marker does not match');
        cursor++;
      }
      if (line.kind !== '-') { output.push(line.text); if (cursor >= source.length) finalNewline = !line.noNewline; }
    }
  }
  output.push(...source.slice(cursor));
  if (target.delete && output.length !== 0) invalid('deletion must remove the complete file');
  return output.length === 0 ? '' : output.join(eol) + (finalNewline ? eol : '');
}
