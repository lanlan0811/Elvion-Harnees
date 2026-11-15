import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ElvionError } from '@elvion/kernel';
import { hash } from './files.js';
import { pathExists } from './paths.js';
import type { Inputs } from './schemas.js';
import { runProcess, type ProcessOptions, type ProcessResult } from './process.js';

const prefix = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.external=', '-c', 'protocol.file.allow=never'];
export async function git(args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return runProcess('git', [...prefix, ...args], { ...options, superviseTree: options.superviseTree ?? false });
}

/** Remember the original state of only files that Elvion attempts to edit. */
export class GitOwnership {
  private readonly clean = new Map<string, boolean>();
  private readonly expected = new Map<string, string | null>();
  async capture(path: string, options: ProcessOptions): Promise<void> {
    if (this.clean.has(path)) return;
    const result = await git(['status', '--porcelain=v1', '-z', '--', path], options);
    this.clean.set(path, result.exitCode === 0 && result.stdout.length === 0);
  }
  record(path: string, afterHash: string | null): void { this.expected.set(path, afterHash); }
  async assertOwned(paths: string[]): Promise<void> {
    if (!paths.length || paths.some(path => this.clean.get(path) !== true)) throw new ElvionError('permission_denied', 'Git writes require explicit files edited by this runtime from a clean Git baseline');
    for (const path of paths) {
      const current = await pathExists(path) ? hash(await readFile(path)) : null;
      if (!this.expected.has(path) || current !== this.expected.get(path)) throw new ElvionError('conflict', 'A file changed outside this runtime; Git write was not attempted');
    }
  }
}

export async function executeGit(input: Inputs<'git'>, paths: string[], ownership: GitOwnership, options: ProcessOptions): Promise<ProcessResult> {
  const relPaths = paths.map(path => relative(options.cwd, path).replaceAll('\\', '/'));
  switch (input.operation) {
    case 'init': return git(['init'], options);
    case 'status': return git(['status', '--porcelain=v1', '--branch', '--', ...relPaths], options);
    case 'diff': return git(['diff', '--no-ext-diff', '--no-textconv', ...(input.staged ? ['--cached'] : []), '--', ...relPaths], options);
    case 'log': return git(['log', `--max-count=${input.limit}`, '--format=%h %s', input.ref, '--', ...relPaths], options);
    case 'show': return git(['show', '--no-ext-diff', '--no-textconv', '--format=medium', input.ref, '--', ...relPaths], options);
    case 'add':
      await ownership.assertOwned(paths);
      return git(['add', '--', ...relPaths], { ...options, superviseTree: true });
    case 'commit': {
      await ownership.assertOwned(paths);
      if (!input.message) throw new ElvionError('validation_error', 'Commit requires a message');
      const staged = await git(['diff', '--cached', '--name-only', '-z'], options);
      if (staged.exitCode !== 0) return staged;
      const stagedPaths = staged.stdout.split('\0').filter(Boolean);
      if (stagedPaths.some(path => !relPaths.includes(path))) throw new ElvionError('conflict', 'Unrelated staged changes exist; commit was not attempted');
      return git(['-c', 'commit.gpgSign=false', 'commit', '--only', '-m', input.message, '--', ...relPaths], { ...options, superviseTree: true });
    }
  }
}
