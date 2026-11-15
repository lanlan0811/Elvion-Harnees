import { z } from 'zod';
import type { ToolDescriptor, JsonObject } from '@elvion/kernel';

const path = z.string().min(1).max(32_000).refine(value => !value.includes('\0'), 'Paths must not contain NUL');
const range = { startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() };
const timeoutMs = z.number().int().min(1).max(1_800_000).default(120_000);
const search = { path: path.default('.'), maxResults: z.number().int().min(1).max(2_000).default(200), exclude: z.array(z.string().min(1).max(256)).max(100).default([]) };

export const inputSchemas = {
  bash: z.strictObject({ command: z.string().min(1).max(100_000).refine(value => !value.includes('\0'), 'Commands must not contain NUL'), cwd: path.default('.'), timeoutMs }),
  read_file: z.strictObject({ path, ...range }).refine(value => value.endLine === undefined || value.endLine >= (value.startLine ?? 1), 'endLine must be at least startLine'),
  write_file: z.strictObject({ path, content: z.string().max(2_000_000), overwrite: z.boolean().default(false), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  edit_file: z.strictObject({ path, oldText: z.string().min(1).max(2_000_000), newText: z.string().max(2_000_000), expectedMatches: z.number().int().min(1).max(10_000).default(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  grep: z.strictObject({ ...search, pattern: z.string().min(1).max(1_000).refine(value => !value.includes('\0') && !value.includes('\n'), 'Search pattern must be one line'), regex: z.boolean().default(false), caseSensitive: z.boolean().default(true), filePattern: z.string().min(1).max(256).default('**/*') }),
  glob: z.strictObject({ ...search, pattern: z.string().min(1).max(256) }),
  git: z.strictObject({ operation: z.enum(['init', 'status', 'diff', 'log', 'show', 'add', 'commit']), cwd: path.default('.'), paths: z.array(path).max(200).default([]), message: z.string().min(1).max(10_000).optional(), ref: z.string().regex(/^(?!-)[A-Za-z0-9_./~^@-]+$/).max(200).default('HEAD'), limit: z.number().int().min(1).max(100).default(10), staged: z.boolean().default(false), timeoutMs }),
  diff: z.strictObject({ cwd: path.default('.'), paths: z.array(path).max(200).default([]), staged: z.boolean().default(false) }),
  apply_patch: z.strictObject({ patch: z.string().min(1).max(2_000_000) }),
  todo: z.strictObject({ operation: z.enum(['list', 'add', 'update', 'remove']), id: z.string().min(1).max(128).optional(), text: z.string().min(1).max(2_000).optional(), status: z.enum(['pending', 'in_progress', 'completed']).optional() }),
};
export type ToolName = keyof typeof inputSchemas;
export type Inputs<K extends ToolName> = z.infer<(typeof inputSchemas)[K]>;
const descriptions: Record<ToolName, string> = {
  bash: 'Run an explicitly authorized Git Bash command with working directory, timeout, cancellation and bounded output. This is controlled execution, not an OS sandbox.',
  read_file: 'Read UTF-8 text with optional 1-based inclusive line range; returns content and SHA-256. Binary and oversized files are rejected.',
  write_file: 'Create a UTF-8 file. Existing files require overwrite=true; expectedHash optionally prevents stale overwrites. Returns change records.',
  edit_file: 'Replace exact text only when the non-overlapping match count equals expectedMatches. Preserves other text and line endings.',
  grep: 'Search text in a bounded directory traversal. Default is literal text; regex uses Git extended regex in a cancellable process.',
  glob: 'Find regular files with a workspace-relative glob. Excludes metadata, dependencies, builds and symlink traversal.',
  git: 'Run a structured Git operation. Destructive history commands are unavailable. Add/commit accept only explicit clean-baseline files changed by this runtime.',
  diff: 'Read actual Git working tree or staged diff, including file and line changes, with external diff and text conversion disabled.',
  apply_patch: 'Validate an entire unified diff before changing any file; exact context and counts required. Supports create, edit and delete, with rollback on write failure.',
  todo: 'Manage auxiliary todo items. Todo completion does not complete or verify the coding task.',
};
export function descriptors(): ToolDescriptor[] {
  return (Object.keys(inputSchemas) as ToolName[]).map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(inputSchemas[name], { unrepresentable: 'any' }) as JsonObject }));
}
