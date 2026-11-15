import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ElvionError } from '@elvion/kernel';

export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** Resolve every existing ancestor, including Windows junctions; missing leaves stay under that canonical ancestor. */
export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw new ElvionError('not_found', 'Path root does not exist');
    return resolve(await canonicalPath(parent), basename(path));
  }
}

export async function resolvePath(workspace: string, input: string): Promise<{ path: string; outside: boolean }> {
  if (input.includes('\0')) throw new ElvionError('validation_error', 'Path contains NUL');
  if (process.platform === 'win32' && (/^(\\\\[?.]\\)/.test(input) || input.replace(/^[A-Za-z]:/, '').includes(':'))) {
    throw new ElvionError('validation_error', 'Device paths and alternate data streams are unsupported');
  }
  const path = await canonicalPath(resolve(workspace, input));
  return { path, outside: !isWithin(workspace, path) };
}

export function assertWritablePath(workspace: string, path: string): void {
  const parts = relative(workspace, path).split(/[\\/]/);
  if (parts.some(part => part.toLowerCase() === '.git')) throw new ElvionError('permission_denied', 'Repository metadata must be modified through the Git tool');
  if (path === workspace) throw new ElvionError('permission_denied', 'A workspace root cannot be replaced as a file');
}

export async function assertRegularFile(path: string, maxBytes: number): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new ElvionError('validation_error', 'Target is not a regular file');
  if (info.size > maxBytes) throw new ElvionError('validation_error', `File exceeds the ${maxBytes} byte limit`);
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
