import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker, type ToolCall } from '@elvion/kernel';
import { ToolRuntime } from '@elvion/tool';
import { analyzeProject } from './project.js';

describe('bounded pre-planning project analysis', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'elvion-analysis-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const options = () => ({ tools: new ToolRuntime(), budget: new BudgetTracker(), context: { workspace: directory, permissionMode: 'auto-edit' as const, signal: new AbortController().signal } });
  it('reads actual root and nested rules, scripts and bounded overview without editing', async () => {
    await mkdir(join(directory, 'src'));
    const manifest = JSON.stringify({ scripts: { test: 'node check.mjs' } });
    await writeFile(join(directory, 'package.json'), manifest);
    await writeFile(join(directory, 'AGENTS.md'), 'Preserve existing module interfaces');
    await writeFile(join(directory, 'src/AGENTS.md'), 'Use exact public types');
    await writeFile(join(directory, 'README.md'), 'readme '.repeat(1000));
    const started: ToolCall[] = []; const ended: string[] = []; const settings = options();
    const result = await analyzeProject({ ...settings, onToolStarted: async call => { started.push(call); }, onToolFinished: async result => { ended.push(result.toolCallId); } });
    expect(result.files).toContain('package.json');
    expect(result.documents[0]).toMatchObject({ path: 'AGENTS.md', content: 'Preserve existing module interfaces' });
    expect(result.documents.some(document => document.path === 'src/AGENTS.md')).toBe(true);
    expect(result.documents.find(document => document.path === 'package.json')?.content).toBe(manifest);
    expect(result.documents.find(document => document.path === 'README.md')).toMatchObject({ truncated: true });
    expect(result.documents.reduce((size, document) => size + document.content.length, 0)).toBeLessThanOrEqual(16_000);
    expect(started.map(call => call.id)).toEqual(ended); expect(settings.budget.snapshot().toolCalls).toBe(started.length);
    expect(started.every(call => ['glob', 'read_file'].includes(call.name))).toBe(true);
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(manifest);
  });
  it('honors ask approval and reports denial or missing interaction without model access', async () => {
    await expect(analyzeProject({ ...options(), context: { ...options().context, permissionMode: 'ask' } })).rejects.toMatchObject({ code: 'approval_required' });
    let approvals = 0;
    await expect(analyzeProject({ ...options(), context: { ...options().context, permissionMode: 'ask', approve: async request => { approvals++; return { requestId: request.id, decision: 'denied' }; } } })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(approvals).toBe(1);
  });
  it('limits inventory and preserves empty projects without inventing structure', async () => {
    const empty = await analyzeProject(options()); expect(empty).toEqual({ files: [], truncated: false, documents: [] });
    for (let index = 0; index < 130; index++) await writeFile(join(directory, `${index}.txt`), 'data');
    const result = await analyzeProject(options()); expect(result.files.length).toBeLessThanOrEqual(120); expect(result.truncated).toBe(true);
  });
});
