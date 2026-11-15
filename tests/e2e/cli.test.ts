import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EventEnvelopeSchema, type EventEnvelope } from '../../packages/kernel/src/index.js';
import { SessionRepository } from '../../packages/session/src/index.js';
import { cancelWindowsCli } from './windows-console.js';

const cli = resolve('dist/cli.js');
let temporary: string; let workspace: string; let dataDirectory: string; let server: Server | undefined;
const active = new Set<ChildProcess>();
beforeEach(async () => { temporary = await mkdtemp(join(tmpdir(), 'elvion-cli-e2e-')); workspace = join(temporary, '中文项目'); dataDirectory = join(temporary, 'data'); await mkdir(workspace); await mkdir(dataDirectory); });
afterEach(async () => {
  for (const child of active) child.kill(); active.clear();
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); server = undefined; }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
interface CliResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function startProgram(entry: string, args: string[], onOutput?: (chunk: string) => void): { child: ChildProcess; result: Promise<CliResult> } {
  const env = { ...process.env, ELVION_DATA_DIR: dataDirectory, NODE_NO_WARNINGS: '1', NO_COLOR: '1' };
  const child = spawn(process.execPath, [entry, ...args], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.add(child);
  const result = new Promise<CliResult>((fulfill, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { const text = chunk.toString('utf8'); stdout += text; onOutput?.(text); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI process exceeded E2E timeout')); }, 90_000);
    child.once('error', error => { clearTimeout(timer); active.delete(child); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); active.delete(child); fulfill({ code, signal, stdout, stderr }); });
  });
  return { child, result };
}
function start(args: string[], onOutput?: (chunk: string) => void): { child: ChildProcess; result: Promise<CliResult> } { return startProgram(cli, [...args, '--workspace', workspace], onOutput); }
async function run(args: string[]): Promise<CliResult> { return start(args).result; }
function events(result: CliResult): EventEnvelope[] {
  expect(result.signal).toBeNull();
  const lines = result.stdout.trim().split('\n').filter(Boolean); expect(lines.length).toBeGreaterThan(0);
  const parsed = lines.map(line => EventEnvelopeSchema.parse(JSON.parse(line)));
  for (let index = 1; index < parsed.length; index++) { expect(parsed[index]!.sequence).toBe(parsed[index - 1]!.sequence + 1); expect(parsed[index]!.sessionId).toBe(parsed[0]!.sessionId); }
  expect(result.stdout).not.toMatch(/ExperimentalWarning|Built CLI|\bundefined\b/); return parsed;
}
async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void | Promise<void>, timeoutMs = 10_000): Promise<void> {
  server = createServer((request, response) => {
    let text = ''; request.on('data', chunk => { text += String(chunk); });
    request.on('end', () => {
      void Promise.resolve(handler(JSON.parse(text) as Record<string, unknown>, response, request)).catch(error => { response.statusCode = 500; response.end(String(error)); });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
  await writeFile(join(dataDirectory, 'providers.json'), JSON.stringify({ version: 1, providers: [{ id: 'local-test', name: 'Local HTTP fixture (not a real model)', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-model', capabilities: { tools: true }, timeoutMs }] }));
}
async function stream(response: ServerResponse, value: { text: string } | { calls: { id: string; name: string; arguments: Record<string, unknown> }[] }): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: unknown, reason: string | null): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  if ('text' in value) {
    response.write(chunk({ content: value.text.slice(0, 2) }, null));
    await new Promise(resolve => setTimeout(resolve, 2));
    response.write(chunk({ content: value.text.slice(2) }, 'stop'));
  } else {
    response.write(chunk({ tool_calls: value.calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments).slice(0, 3) } })) }, null));
    await new Promise(resolve => setTimeout(resolve, 2));
    response.write(chunk({ tool_calls: value.calls.map((call, index) => ({ index, function: { arguments: JSON.stringify(call.arguments).slice(3) } })) }, 'tool_calls'));
  }
  response.end('data: [DONE]\n\n');
}

describe('actual built CLI subprocess', { timeout: 90_000 }, () => {
  it('uses the requested verification timeout and exits 124 without repairing or running later checks', async () => {
    const manifest = JSON.stringify({ type: 'module', scripts: { test: 'node slow.mjs', build: 'node later.mjs' } });
    const slow = "import { writeFileSync } from 'node:fs';\nwriteFileSync('slow-started.txt', String(process.pid));\nsetInterval(() => {}, 1000);\n";
    const later = "import { writeFileSync } from 'node:fs';\nwriteFileSync('later-check.txt', 'must not run');\n";
    await Promise.all([['package.json', manifest], ['slow.mjs', slow], ['later.mjs', later]].map(([name, content]) => writeFile(join(workspace, name!), content!)));
    let planning = 0; let coding = 0;
    await fixture(async (body, response) => {
      if (!Array.isArray(body['tools'])) { planning++; return stream(response, { text: JSON.stringify([{ id: 'slow-check', title: 'Run the unchanged original project check', dependsOn: [], acceptance: ['Original checks pass'] }]) }); }
      coding++; return stream(response, { text: 'Handing off to independent verification.' });
    });
    const result = await run(['run', '验证项目并保留真实超时', '--json', '--permissions', 'full-access', '--verification-timeout', '3000']);
    expect(result.code, result.stdout + result.stderr).toBe(124);
    const emitted = events(result); expect(emitted.at(-1)?.type).toBe('execution.timed_out');
    expect(emitted.some(event => event.type === 'execution.repair' || event.type === 'execution.retry')).toBe(false);
    const reports = emitted.filter(event => event.type === 'verification.finished'); expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toMatchObject({ passed: false, checks: [{ name: 'test', command: ['npm', 'run', 'test'], exitCode: null, status: 'timed_out' }] });
    const report = reports[0]!.payload as { checks: unknown[] }; expect(report.checks).toHaveLength(1);
    expect(JSON.stringify(reports[0]!.payload)).toContain('timeout');
    const verificationCall = emitted.find(event => event.type === 'tool.started' && event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload['name'] === 'bash');
    expect(verificationCall?.payload).toMatchObject({ arguments: { command: 'npm run test', timeoutMs: 3000 } });
    expect(planning).toBe(1); expect(coding).toBe(1);
    const pid = Number(await readFile(join(workspace, 'slow-started.txt'), 'utf8')); expect(pid).toBeGreaterThan(0);
    let stopped = false; for (let attempt = 0; attempt < 50; attempt++) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { stopped = true; break; } throw error; } await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(stopped).toBe(true); await expect(readFile(join(workspace, 'later-check.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'package.json'), 'utf8')).toBe(manifest);
    const saved = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { id: string; state: string }[];
    expect(saved).toHaveLength(1); expect(saved[0]!.state).toBe('timed_out');
    const repository = await SessionRepository.open(join(dataDirectory, 'sessions.sqlite'));
    try { expect((await repository.get(saved[0]!.id))?.checkpoint?.budget.limits.toolTimeoutMs).toBe(3000); } finally { await repository.close(); }
    const resumed = await run(['resume', saved[0]!.id, '--json']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(124); const restored = events(resumed); expect(restored.at(-1)?.type).toBe('execution.timed_out'); expect(restored.at(-1)?.payload).toEqual(emitted.at(-1)?.payload); expect(coding).toBe(1); expect(planning).toBe(1);
    expect(restored.some(event => ['tool.started', 'verification.started', 'verification.finished'].includes(event.type))).toBe(false);
    await expect(readFile(join(workspace, 'later-check.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('repairs actual TypeScript diagnostics across files without changing the original verification gates', async () => {
    const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const manifest = JSON.stringify({ name: 'elvion-typescript-fixture', type: 'module', scripts: { typecheck: 'node typecheck.mjs', test: 'node check.mjs' } });
    const configuration = JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] }, include: ['source.ts', 'consumer.ts'] });
    const checker = ["import { spawnSync } from 'node:child_process';", "const result = spawnSync(process.execPath, [" + JSON.stringify(compiler) + ", '--project', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { stdio: 'inherit' });", 'if (result.error) throw result.error;', 'process.exit(result.status ?? 1);', ''].join('\n');
    const assertions = ["import assert from 'node:assert/strict';", "import { result } from './consumer.ts';", 'assert.equal(result, 42);', "console.log('verified-typescript-project');", ''].join('\n');
    const sourceBefore = "export const value: string = '41';\n";
    const consumerBefore = "import { value } from './source.ts';\nexport const result: number = value;\n";
    const unchanged: [string, string][] = [['package.json', manifest], ['tsconfig.json', configuration], ['typecheck.mjs', checker], ['check.mjs', assertions]];
    await Promise.all([...unchanged, ['source.ts', sourceBefore], ['consumer.ts', consumerBefore]].map(([name, content]) => writeFile(join(workspace, name!), content!)));
    const before = await startProgram(compiler, ['--project', 'tsconfig.json', '--noEmit', '--pretty', 'false']).result;
    expect(before.code, before.stdout + before.stderr).toBe(2);
    expect(before.stdout + before.stderr).toContain("consumer.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.");
    let requests = 0; const bodies: Record<string, unknown>[] = [];
    await fixture(async (body, response) => {
      if (!Array.isArray(body['tools'])) return stream(response, { text: JSON.stringify([{ id: 'typed-coding', title: 'Repair the existing typed modules and pass their unchanged checks', dependsOn: [], acceptance: ['Original TypeScript typecheck and runtime assertions pass'] }]) });
      bodies.push(body); requests++;
      if (requests === 1) return stream(response, { calls: [{ id: 'typed-read-source', name: 'read_file', arguments: { path: 'source.ts' } }, { id: 'typed-read-consumer', name: 'read_file', arguments: { path: 'consumer.ts' } }] });
      if (requests === 2) return stream(response, { calls: [{ id: 'typed-initial-source', name: 'edit_file', arguments: { path: 'source.ts', oldText: "'41'", newText: "'42'" } }, { id: 'typed-initial-consumer', name: 'edit_file', arguments: { path: 'consumer.ts', oldText: '= value;', newText: '= value + 0;' } }] });
      if (requests === 4) {
        expect(JSON.stringify(body)).toContain('Independent verification failed'); expect(JSON.stringify(body)).toContain('TS2322');
        return stream(response, { calls: [{ id: 'typed-repair-source', name: 'edit_file', arguments: { path: 'source.ts', oldText: "export const value: string = '42';", newText: 'export const value: number = 41;' } }, { id: 'typed-repair-consumer', name: 'edit_file', arguments: { path: 'consumer.ts', oldText: '= value + 0;', newText: '= value + 1;' } }] });
      }
      return stream(response, { text: 'Typed changes delivered for independent verification.' });
    });
    const result = await run(['run', '修复现有跨文件类型错误并通过原有检查', '--json', '--permissions', 'full-access']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const emitted = events(result); const reports = emitted.filter(event => event.type === 'verification.finished').map(event => event.payload as { passed: boolean; checks: { name: string; command: string[]; status: string; exitCode: number; evidence: string }[] });
    expect(reports.map(report => report.passed)).toEqual([false, true]);
    expect(reports.map(report => report.checks.map(check => [check.name, check.exitCode, check.status]))).toEqual([[['typecheck', 2, 'failed'], ['test', 1, 'failed']], [['typecheck', 0, 'passed'], ['test', 0, 'passed']]]);
    expect(reports[0]!.checks[0]!.evidence).toContain('TS2322');
    expect(reports[1]!.checks.map(check => check.command)).toEqual([['npm', 'run', 'typecheck'], ['npm', 'run', 'test']]);
    expect(reports[1]!.checks[1]!.evidence).toContain('verified-typescript-project');
    expect(emitted.some(event => event.type === 'execution.repair')).toBe(true); expect(emitted.at(-1)?.type).toBe('execution.completed'); expect(requests).toBe(5);
    expect(JSON.stringify(bodies[1])).toContain(sourceBefore.trim()); expect(JSON.stringify(bodies[1])).toContain('consumer.ts');
    expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('export const value: number = 41;\n');
    expect(await readFile(join(workspace, 'consumer.ts'), 'utf8')).toBe(consumerBefore.replace('= value;', '= value + 1;'));
    for (const [name, content] of unchanged) expect(await readFile(join(workspace, name), 'utf8')).toBe(content);
    const after = await startProgram(compiler, ['--project', 'tsconfig.json', '--noEmit', '--pretty', 'false']).result; expect(after.code, after.stdout + after.stderr).toBe(0);
    const external = await startProgram(join(workspace, 'check.mjs'), []).result; expect(external.code, external.stdout + external.stderr).toBe(0); expect(external.stdout).toContain('verified-typescript-project');
    const saved = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { id: string; state: string }[]; expect(saved).toHaveLength(1); expect(saved[0]!.state).toBe('completed');
    const resumed = await run(['resume', saved[0]!.id, '--json']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0); const restored = events(resumed); expect(restored.at(-1)?.payload).toEqual(emitted.at(-1)?.payload); expect(requests).toBe(5);
    expect(restored.some(event => ['tool.started', 'verification.started', 'verification.finished'].includes(event.type))).toBe(false);
  });
  it('continues a durable checkpoint from an exited Node child in a separate CLI process', async () => {
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
    await writeFile(join(workspace, 'check.mjs'), `import assert from 'node:assert/strict';\nimport { appendFileSync, existsSync, readFileSync } from 'node:fs';\nassert.equal(readFileSync('first.mjs','utf8'),'export const first = 1;\\n');\nif(existsSync('second.mjs'))assert.equal(readFileSync('second.mjs','utf8'),'export const second = 2;\\n');\nappendFileSync('verification.log','verified\\n');\nconsole.log('checkpoint-real-verification');\n`);
    let requests = 0; const bodies: Record<string, unknown>[] = [];
    await fixture(async (body, response) => {
      bodies.push(body); requests++;
      if (!Array.isArray(body['tools'])) throw new Error('Restored task must not replan');
      if (requests === 1) return stream(response, { calls: [{ id: 'first-write', name: 'write_file', arguments: { path: 'first.mjs', content: 'export const first = 1;\n' } }] });
      if (requests === 3) return stream(response, { calls: [{ id: 'second-write', name: 'write_file', arguments: { path: 'second.mjs', content: 'export const second = 2;\n' } }] });
      return stream(response, { text: 'Independent checkpoint increment delivered.' });
    });
    const childFile = join(temporary, 'checkpoint-child.mjs');
    const moduleUrl = (name: string): string => pathToFileURL(resolve('dist/packages', name, 'index.js')).href;
    await writeFile(childFile, `import {readFile} from 'node:fs/promises';\nimport {join} from 'node:path';\nimport {executeTask} from ${JSON.stringify(moduleUrl('execution'))};\nimport {SessionRepository} from ${JSON.stringify(moduleUrl('session'))};\nimport {ProviderRuntime} from ${JSON.stringify(moduleUrl('model'))};\nconst workspace=process.argv[2],data=process.argv[3];\nconst provider=JSON.parse(await readFile(join(data,'providers.json'),'utf8')).providers[0];\nconst repository=await SessionRepository.open(join(data,'sessions.sqlite'));\ntry{for await(const event of executeTask({task:'Original durable cross-file goal',workspace,providerId:provider.id,model:provider.model,runtime:new ProviderRuntime(provider),repository,permissions:'full-access',signal:new AbortController().signal,lockDirectory:join(data,'locks'),plan:[{id:'first',title:'First independent increment',dependsOn:[],acceptance:['Original npm test passes']},{id:'second',title:'Second dependent increment',dependsOn:['first'],acceptance:['Original npm test passes']}]})){process.stdout.write(JSON.stringify(event)+'\\n');if(event.type==='task.completed'&&event.payload.taskId==='first')break;}}finally{await repository.close();}\n`);
    const first = await startProgram(childFile, [workspace, dataDirectory]).result;
    expect(first.code, first.stdout + first.stderr).toBe(0); const before = events(first);
    expect(before.at(-1)?.type).toBe('task.completed'); expect(requests).toBe(2);
    expect(await readFile(join(workspace, 'first.mjs'), 'utf8')).toBe('export const first = 1;\n');
    await expect(readFile(join(workspace, 'second.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    const savedList = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { id: string; state: string }[];
    expect(savedList).toHaveLength(1);
    const resumed = await run(['resume', savedList[0]!.id, '--json']);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0); const after = events(resumed);
    expect(after[0]?.sequence).toBe(before.at(-1)!.sequence + 1); expect(after.at(-1)?.type).toBe('execution.completed');
    expect(after.some(event => event.type === 'execution.resumed')).toBe(true);
    expect(after.some(event => event.type === 'task.planning' || event.type === 'task.planned')).toBe(false);
    expect(after.filter(event => event.type === 'task.started').map(event => event.payload)).toMatchObject([{ task: { id: 'second' } }]);
    expect(requests).toBe(4); expect(JSON.stringify(bodies.slice(2))).toContain('Original durable cross-file goal');
    expect(await readFile(join(workspace, 'first.mjs'), 'utf8')).toBe('export const first = 1;\n');
    expect(await readFile(join(workspace, 'second.mjs'), 'utf8')).toBe('export const second = 2;\n');
    expect((await readFile(join(workspace, 'verification.log'), 'utf8')).trim().split('\n')).toEqual(['verified', 'verified']);
    expect(after.filter(event => event.type === 'tool.started' && JSON.stringify(event.payload).includes('first.mjs'))).toHaveLength(0);
    const last = after.at(-1)!.payload as { budget: { turns: number; toolCalls: number }; tasks: { status: string }[] };
    expect(last.budget.turns).toBe(4); expect(last.budget.toolCalls).toBeGreaterThan(4); expect(last.tasks.every(task => task.status === 'completed')).toBe(true);
    expect(JSON.stringify(after.find(event => event.type === 'verification.finished')?.payload)).toContain('checkpoint-real-verification');
  });
  it('prints version/help and keeps configuration failures as valid JSON with exit 2', async () => {
    const version = await run(['--version']); expect(version.code).toBe(0); expect(version.stdout.trim()).toBe('0.1.0');
    const help = await run(['--help']); expect(help.code).toBe(0); expect(help.stdout).toContain('elvion run');
    const missing = await run(['run', 'test', '--json']); expect(missing.code).toBe(2); expect(events(missing).at(-1)?.type).toBe('cli.error');
    const malformed = await run(['run', 'test', '--unknown', '--json']); expect(malformed.code).toBe(2); expect(events(malformed).at(-1)?.type).toBe('cli.error');
    const sessions = await run(['sessions', 'list', '--json']); expect(sessions.code).toBe(0); expect(JSON.parse(sessions.stdout)).toEqual([]);
  });
  it('creates real cross-file code, repairs failed verification, persists and resumes the session', async () => {
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'elvion-cross-file-fixture', type: 'module', scripts: { test: 'node check.mjs' } }));
    await writeFile(join(workspace, 'check.mjs'), `import assert from 'node:assert/strict';\nimport { result } from './consumer.mjs';\nassert.equal(result, 42);\nconsole.log('verified-real-project');\n`);
    let requests = 0; const requestsBodies: Record<string, unknown>[] = [];
    await fixture(async (body, response) => {
      if (!Array.isArray(body['tools'])) return stream(response, { text: JSON.stringify([{ id: 'coding', title: 'Implement cross-file change and pass actual project tests', dependsOn: [], acceptance: ['Actual project test script exits zero'] }]) });
      requestsBodies.push(body); requests++;
      if (requests === 1) return stream(response, { calls: [
        { id: 'create-source', name: 'write_file', arguments: { path: 'source.mjs', content: 'export const value = 41;\n' } },
        { id: 'create-consumer', name: 'write_file', arguments: { path: 'consumer.mjs', content: `import { value } from './source.mjs';\nexport const result = value;\n` } },
      ] });
      if (requests === 3) return stream(response, { calls: [{ id: 'repair-source', name: 'edit_file', arguments: { path: 'source.mjs', oldText: '41', newText: '42' } }] });
      return stream(response, { text: requests >= 5 ? '重新核实完成。' : '文件已完成，交给独立验证。' });
    });
    const result = await run(['run', '创建跨文件模块并通过测试', '--json', '--permissions', 'full-access']);
    expect(result.code, result.stdout + result.stderr).toBe(0); const emitted = events(result);
    expect(emitted.at(-1)?.type).toBe('execution.completed'); expect(emitted.some(event => event.type === 'execution.repair')).toBe(true);
    const reports = emitted.filter(event => event.type === 'verification.finished').map(event => event.payload as Record<string, unknown>);
    expect(reports.map(report => report['passed'])).toEqual([false, true]);
    expect(JSON.stringify(reports.at(-1))).toContain('verified-real-project');
    expect(await readFile(join(workspace, 'source.mjs'), 'utf8')).toBe('export const value = 42;\n');
    expect(await readFile(join(workspace, 'consumer.mjs'), 'utf8')).toContain('source.mjs');
    expect(requests).toBe(4); expect(JSON.stringify(requestsBodies[2])).toContain('Independent verification failed');
    const usage = emitted.find(event => event.type === 'model.usage'); expect(usage?.payload).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    const list = await run(['sessions', 'list', '--json']); const saved = JSON.parse(list.stdout) as { id: string; state: string; permissions: string }[];
    expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ state: 'completed', permissions: 'full-access' });
    const resumed = await run(['resume', saved[0]!.id, '--json']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const continued = events(resumed); expect(continued[0]?.sequence).toBeGreaterThan(emitted.at(-1)!.sequence); expect(continued[0]?.sessionId).toBe(saved[0]!.id); expect(continued.at(-1)?.type).toBe('execution.completed');
    expect(continued.some(event => event.type === 'session.restored')).toBe(true); expect(requests).toBe(4);
  });
  it('returns approval-required exit 3 without executing a requested file write', async () => {
    await fixture(async (body, response) => !Array.isArray(body['tools']) ? stream(response, { text: JSON.stringify([{ id: 'coding', title: 'Write test file', dependsOn: [], acceptance: ['File exists'] }]) }) : stream(response, { calls: [{ id: 'write', name: 'write_file', arguments: { path: 'denied.txt', content: 'must not exist' } }] }));
    const result = await run(['run', 'test approval', '--json', '--permissions', 'ask']); expect(result.code).toBe(3);
    const emitted = events(result); expect(emitted.at(-1)?.type).toBe('execution.approval_required'); expect(JSON.stringify(emitted)).toContain('approval_required');
    await expect(readFile(join(workspace, 'denied.txt'))).rejects.toThrow();
    const saved = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { permissions: string; state: string }[]; expect(saved[0]).toMatchObject({ permissions: 'ask', state: 'approval_required' });
  });
  it('returns timeout exit 124 for a real stalled HTTP stream and persists the terminal state', async () => {
    await fixture((_body, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': connected\n\n'); }, 150);
    const result = await run(['run', 'test timeout', '--json']); expect(result.code, result.stdout + result.stderr).toBe(124); expect(events(result).at(-1)?.type).toBe('execution.timed_out');
    const saved = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { state: string }[]; expect(saved[0]?.state).toBe('timed_out');
  });
  it.runIf(process.platform !== 'win32')('returns cancel exit 130 after a genuine SIGINT and saves cancelled state', async () => {
    await fixture((_body, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': connected\n\n'); });
    let signalSent = false; const started = start(['run', 'test cancellation', '--json'], chunk => {
      if (!signalSent && chunk.includes('execution.started')) { signalSent = true; started.child.kill('SIGINT'); }
    });
    const result = await started.result; expect(signalSent).toBe(true); expect(result.code, result.stdout + result.stderr).toBe(130); expect(events(result).at(-1)?.type).toBe('execution.cancelled');
    const saved = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { state: string }[]; expect(saved[0]?.state).toBe('cancelled');
  });
  it.runIf(process.platform === 'win32')('returns cancel exit 130 after an actual Windows console Ctrl+C and saves cancelled state', async () => {
    await fixture((_body, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': connected\n\n'); }, 60_000);
    const result = await cancelWindowsCli(cli, ['run', 'test Windows cancellation', '--json'], workspace, dataDirectory, temporary);
    expect(result.code, result.stdout + result.stderr).toBe(130); expect(events(result).at(-1)?.type).toBe('execution.cancelled');
    const saved = JSON.parse((await run(['sessions', 'list', '--json'])).stdout) as { state: string }[]; expect(saved[0]?.state).toBe('cancelled');
  });
});
