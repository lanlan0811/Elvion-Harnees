import { randomUUID } from 'node:crypto';
import { ElvionError, throwIfAborted, type BudgetTracker, type JsonValue, type ToolCall, type ToolResult } from '@elvion/kernel';
import { ToolRuntime, type ToolContext } from '@elvion/tool';

export interface ProjectAnalysisOptions {
  tools: ToolRuntime; context: ToolContext; budget: BudgetTracker;
  onToolStarted?: (call: ToolCall) => Promise<void>; onToolFinished?: (result: ToolResult) => Promise<void>;
}
export interface ProjectAnalysis { files: string[]; truncated: boolean; documents: { path: string; content: string; truncated: boolean }[] }
function output(result: ToolResult): Record<string, JsonValue> {
  if (result.status !== 'success' || !result.output || typeof result.output !== 'object' || Array.isArray(result.output)) throw new ElvionError('tool_error', 'Project analysis returned no structured output');
  return result.output;
}
async function execute(options: ProjectAnalysisOptions, name: string, args: Record<string, JsonValue>): Promise<ToolResult> {
  throwIfAborted(options.context.signal); options.budget.consumeToolCall();
  const call = { id: randomUUID(), name, arguments: args };
  await options.onToolStarted?.(call);
  const result = await options.tools.execute(call, options.context);
  await options.onToolFinished?.(result);
  throwIfAborted(options.context.signal); options.budget.assertTimeRemaining();
  if (result.status === 'approval_required') throw new ElvionError('approval_required', 'Project analysis requires approval');
  if (result.status === 'denied') throw new ElvionError('permission_denied', 'Project analysis was denied');
  if (result.status === 'cancelled') throw new ElvionError('cancelled', 'Project analysis was cancelled');
  if (result.status !== 'success') throw new ElvionError('tool_error', 'Project analysis failed', { details: { tool: name } });
  return result;
}

/** Read a bounded overview before planning; every access uses the ordinary tool permission boundary. */
export async function analyzeProject(options: ProjectAnalysisOptions): Promise<ProjectAnalysis> {
  const inventory = await execute(options, 'glob', { pattern: '**/*', path: '.', maxResults: 120 });
  const candidates = output(inventory)['files'];
  if (!Array.isArray(candidates) || candidates.some(path => typeof path !== 'string')) throw new ElvionError('tool_error', 'Project inventory contains invalid paths');
  const files = candidates as string[];
  const rules = await execute(options, 'glob', { pattern: '**/AGENTS.md', path: '.', maxResults: 20, exclude: [] });
  const rulesFiles = output(rules)['files'];
  if (!Array.isArray(rulesFiles) || rulesFiles.some(path => typeof path !== 'string')) throw new ElvionError('tool_error', 'Project rules inventory contains invalid paths');
  // Parent/root guidance takes priority over deeper files. All content remains untrusted data.
  const rulePaths = (rulesFiles as string[]).sort((left, right) => left.replaceAll('\\', '/').split('/').length - right.replaceAll('\\', '/').split('/').length || left.localeCompare(right));
  const preferred = ['AGENTS.md', 'package.json', 'README.md', 'tsconfig.json', 'pnpm-workspace.yaml'];
  const documents: ProjectAnalysis['documents'] = [];
  const paths = [...new Set([...rulePaths, ...preferred.filter(path => files.includes(path))])].slice(0, 8);
  let truncated = inventory.truncated || rules.truncated || paths.length < new Set([...rulePaths, ...preferred.filter(path => files.includes(path))]).size;
  let remaining = 16_000;
  for (const path of paths) {
    if (remaining <= 0) break;
    const result = await execute(options, 'read_file', { path, startLine: 1, endLine: 120 });
    const content = output(result)['content'];
    if (typeof content !== 'string') throw new ElvionError('tool_error', 'Project document returned no text');
    const selected = content.slice(0, Math.min(4000, remaining)); remaining -= selected.length;
    const metadata = output(result);
    const documentTruncated = result.truncated || selected.length < content.length || (typeof metadata['totalLines'] === 'number' && typeof metadata['endLine'] === 'number' && metadata['endLine'] < metadata['totalLines']);
    truncated ||= documentTruncated;
    documents.push({ path, content: selected, truncated: documentTruncated });
  }
  return { files, truncated: truncated || documents.length < paths.length, documents };
}
