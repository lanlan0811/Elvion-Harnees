import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative } from 'node:path';
import { ElvionError } from '@elvion/kernel';
import { assertRegularFile, pathExists } from './paths.js';

export interface ChangeRecord { path: string; beforeHash: string | null; afterHash: string | null; kind: 'created' | 'modified' | 'deleted' }
export function hash(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
export async function readText(path: string, maxBytes: number): Promise<string> {
  await assertRegularFile(path, maxBytes);
  const buffer = await readFile(path);
  if (buffer.length > maxBytes) throw new ElvionError('validation_error', 'File grew beyond the configured limit');
  if (buffer.includes(0)) throw new ElvionError('validation_error', 'Binary files are unsupported');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch (cause) { throw new ElvionError('validation_error', 'File is not valid UTF-8', { cause }); }
}

export async function atomicWrite(path: string, content: string, expected: string | null): Promise<ChangeRecord> {
  const exists = await pathExists(path);
  const currentHash = exists ? hash(await readFile(path)) : null;
  if (currentHash !== expected) throw new ElvionError('conflict', 'File changed after it was read; no write was applied');
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.elvion-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: exists ? (await stat(path)).mode : 0o600 });
    if ((await pathExists(path) ? hash(await readFile(path)) : null) !== expected) throw new ElvionError('conflict', 'File changed while preparing the write');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return { path, beforeHash: currentHash, afterHash: hash(content), kind: exists ? 'modified' : 'created' };
}

const ignored = new Set(['.git', 'node_modules', '.elvion', '.codex', 'dist', 'coverage', '.cache']);
export async function walkFiles(root: string, options: { pattern: string; exclude: string[]; signal: AbortSignal; maxFiles?: number }): Promise<string[]> {
  if (options.pattern.includes('..') || /^[\\/]|^[A-Za-z]:/.test(options.pattern)) throw new ElvionError('validation_error', 'Glob patterns must remain relative to the search root');
  const found: string[] = []; let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    if (options.signal.aborted) throw new ElvionError('cancelled', 'Search was cancelled');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > (options.maxFiles ?? 20_000)) throw new ElvionError('validation_error', 'Search exceeds the directory-entry budget; narrow its scope');
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const target = join(directory, entry.name);
      const name = relative(root, target).replaceAll('\\', '/');
      if (options.exclude.some(pattern => matchesGlob(name, pattern) || matchesGlob(`${name}/`, pattern))) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && matchesGlob(name, options.pattern)) found.push(target);
    }
  };
  await walk(root);
  return found;
}
