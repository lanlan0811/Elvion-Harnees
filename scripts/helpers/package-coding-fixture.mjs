import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TextEncoder } from 'node:util';

const sourceBefore = 'export const value = 0;\n';
const consumerBefore = 'export const result = 0;\n';
const sourceAfter = 'export const value = 42;\n';
const consumerAfter = "import { value } from './source.mjs';\nexport const result = value;\n";
const plan = [{ id: 'installed-coding', title: 'Repair the two modules and pass the original npm test', dependsOn: [], acceptance: ['The original npm test executes and exits zero'] }];

/** Parse the installed process output independently of unpublished workspace packages. */
export function parseEventLines(stdout) {
  assert.ok(stdout.endsWith('\n'), 'NDJSON output must end with a complete line');
  const lines = stdout.trimEnd().split('\n');
  assert.ok(lines.length > 0);
  const events = lines.map((line, index) => {
    assert.ok(line.trim(), `NDJSON line ${index + 1} must not be empty`);
    const value = JSON.parse(line);
    assert.equal(value.version, 1);
    assert.ok(Number.isInteger(value.sequence) && value.sequence > 0);
    assert.equal(typeof value.sessionId, 'string');
    assert.ok(value.sessionId.length > 0);
    assert.equal(typeof value.type, 'string');
    assert.ok(value.type.length > 0);
    assert.ok(!Number.isNaN(Date.parse(value.timestamp)));
    assert.ok(Object.hasOwn(value, 'payload'));
    return value;
  });
  for (let index = 1; index < events.length; index++) {
    assert.equal(events[index].sequence, events[index - 1].sequence + 1);
    assert.equal(events[index].sessionId, events[0].sessionId);
  }
  return events;
}

function toolResults(body) {
  const results = new Map();
  for (const message of body.messages ?? []) {
    if (message.role !== 'tool') continue;
    const result = JSON.parse(message.content);
    assert.equal(result.toolCallId, message.tool_call_id);
    assert.equal(result.status, 'success', `Fixture tool ${result.toolCallId} must actually succeed`);
    results.set(message.tool_call_id, result.output);
  }
  return results;
}

function codingResponse(body) {
  const results = toolResults(body);
  const repairing = body.messages.some(message => message.role === 'user' && message.content.includes('Independent verification failed'));
  if (repairing) {
    if (!results.has('repair-source')) return { calls: [{ id: 'repair-source', name: 'edit_file', arguments: { path: 'source.mjs', oldText: '41', newText: '42', expectedMatches: 1 } }] };
    return { text: '跨文件修复完成，请独立执行原有 npm 测试。' };
  }
  if (!results.has('read-source')) return { calls: ['package.json', 'check.mjs', 'source.mjs', 'consumer.mjs'].map((path, index) => ({ id: ['read-package', 'read-check', 'read-source', 'read-consumer'][index], name: 'read_file', arguments: { path } })) };
  assert.equal(results.get('read-source').content, sourceBefore);
  assert.equal(results.get('read-consumer').content, consumerBefore);
  if (!results.has('write-source')) return { calls: [
    { id: 'write-source', name: 'write_file', arguments: { path: 'source.mjs', content: 'export const value = 41;\n', overwrite: true, expectedHash: results.get('read-source').hash } },
    { id: 'write-consumer', name: 'write_file', arguments: { path: 'consumer.mjs', content: consumerAfter, overwrite: true, expectedHash: results.get('read-consumer').hash } },
  ] };
  return { text: '两个模块已更新，请独立验证；模型声明不替代测试。' };
}

async function respond(response, value, requestNumber) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  let body;
  if ('text' in value) body = chunk({ content: value.text.slice(0, 2) }, null) + chunk({ content: value.text.slice(2) }, 'stop');
  else body = chunk({ tool_calls: value.calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments).slice(0, 3) } })) }, null)
    + chunk({ tool_calls: value.calls.map((call, index) => ({ index, function: { arguments: JSON.stringify(call.arguments).slice(3) } })) }, 'tool_calls');
  body += `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: requestNumber * 10, completion_tokens: 3, total_tokens: requestNumber * 10 + 3 } })}\n\n` + 'data: [DONE]\n\n';
  // Real byte fragmentation exercises UTF-8 and JSON decoding in the installed adapter.
  const bytes = new TextEncoder().encode(body);
  for (let offset = 0; offset < bytes.length; offset += 17) {
    if (response.destroyed) return;
    response.write(bytes.subarray(offset, offset + 17));
    await new Promise(done => globalThis.setTimeout(done, 1));
  }
  response.end();
}

function readDatabase(path, sessionId) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const snapshot = database.prepare('SELECT snapshot FROM sessions WHERE id=?').get(sessionId);
    assert.ok(snapshot, 'The installed worker must persist a real SQLite session');
    return { snapshot: JSON.parse(snapshot.snapshot), events: database.prepare('SELECT event FROM events WHERE session_id=? ORDER BY sequence').all(sessionId).map(row => JSON.parse(row.event)) };
  } finally { database.close(); }
}

/** Loopback protocol fixture; this deliberately makes no claim of live-provider acceptance. */
export async function verifyInstalledCoding({ scratch, dataDirectory, runCli, runNpm }) {
  const workspacePath = join(scratch, '独立编码项目');
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const manifest = JSON.stringify({ name: 'elvion-installed-coding-fixture', private: true, type: 'module', scripts: { test: 'node check.mjs' } }, null, 2);
  const check = "import assert from 'node:assert/strict';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport { result } from './consumer.mjs';\nlet count = 0;\ntry { count = Number(readFileSync('.verification-count', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }\nwriteFileSync('.verification-count', String(count + 1));\nassert.equal(result, 42);\nconsole.log('installed-artifact-verified-real-project');\n";
  await Promise.all([['package.json', manifest], ['check.mjs', check], ['source.mjs', sourceBefore], ['consumer.mjs', consumerBefore]].map(([name, content]) => writeFile(join(workspace, name), content)));
  let planningRequests = 0; let codingRequests = 0; const errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, undefined, 'The smoke fixture must not use account credentials');
      request.setEncoding('utf8'); let text = '';
      for await (const chunk of request) { text += chunk; assert.ok(text.length < 2_000_000); }
      const body = JSON.parse(text); assert.equal(body.model, 'installed-fixture-model'); assert.equal(body.stream, true);
      if (!Array.isArray(body.tools)) { planningRequests++; assert.equal(planningRequests, 1); return await respond(response, { text: JSON.stringify(plan) }, 1); }
      assert.equal(body.tools.length, 10); codingRequests++; assert.ok(codingRequests <= 5, 'Unexpected coding loop or retry');
      await respond(response, codingResponse(body), codingRequests);
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' }); response.end('Installed fixture rejected the request'); });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await runCli(['providers', 'add', 'installed-fixture', '--name', 'Local HTTP distribution fixture', '--protocol', 'openai-chat', '--url', `http://127.0.0.1:${address.port}/v1`, '--model', 'installed-fixture-model', '--tools', 'true', '--json'], workspace);
    const configured = JSON.parse((await runCli(['providers', 'list', '--json'], workspace)).stdout);
    assert.equal(configured.length, 1); assert.equal(configured[0].apiKeyEnv, undefined);
    const run = await runCli(['run', '读取原有模块，修复跨文件结果并执行原有测试', '--json', '--permissions', 'full-access'], workspace);
    assert.deepEqual(errors, []);
    const events = parseEventLines(run.stdout); const completed = events.at(-1);
    assert.equal(completed.type, 'execution.completed'); assert.equal(completed.payload.report.passed, true);
    assert.ok(completed.payload.tasks.length > 0 && completed.payload.tasks.every(task => task.status === 'completed'));
    assert.equal(planningRequests, 1); assert.equal(codingRequests, 5);
    assert.ok(events.some(event => event.type === 'execution.repair'));
    const reports = events.filter(event => event.type === 'verification.finished').map(event => event.payload);
    assert.deepEqual(reports.map(report => report.passed), [false, true]);
    for (const [index, report] of reports.entries()) {
      assert.equal(report.checks.length, 1); assert.deepEqual(report.checks[0].command, ['npm', 'run', 'test']);
      assert.equal(report.checks[0].exitCode, index === 0 ? 1 : 0);
      assert.equal(report.checks[0].status, index === 0 ? 'failed' : 'passed');
    }
    assert.match(reports[1].checks[0].evidence, /installed-artifact-verified-real-project/);
    assert.deepEqual(events.filter(event => event.type === 'model.usage').map(event => event.payload), [1, 2, 3, 4, 5].map(number => ({ inputTokens: number * 10, outputTokens: 3, totalTokens: number * 10 + 3 })));
    const reads = events.filter(event => event.type === 'tool.finished' && ['read-source', 'read-consumer'].includes(event.payload.toolCallId));
    assert.deepEqual(reads.map(event => event.payload.output.content), [sourceBefore, consumerBefore]);
    const assertFiles = async () => {
      assert.equal(await readFile(join(workspace, 'source.mjs'), 'utf8'), sourceAfter);
      assert.equal(await readFile(join(workspace, 'consumer.mjs'), 'utf8'), consumerAfter);
      assert.equal(await readFile(join(workspace, 'package.json'), 'utf8'), manifest);
      assert.equal(await readFile(join(workspace, 'check.mjs'), 'utf8'), check);
    };
    await assertFiles(); assert.equal(await readFile(join(workspace, '.verification-count'), 'utf8'), '2');
    assert.match((await runNpm(['run', 'test'], workspace)).stdout, /installed-artifact-verified-real-project/);
    assert.equal(await readFile(join(workspace, '.verification-count'), 'utf8'), '3');
    const saved = JSON.parse((await runCli(['sessions', 'list', '--json'], workspace)).stdout);
    assert.equal(saved.length, 1); assert.equal(saved[0].id, completed.sessionId); assert.equal(saved[0].state, 'completed'); assert.equal(saved[0].permissions, 'full-access');
    const databasePath = join(dataDirectory, 'sessions.sqlite');
    assert.equal((await readFile(databasePath)).subarray(0, 16).toString(), 'SQLite format 3\0');
    const stored = readDatabase(databasePath, completed.sessionId);
    assert.equal(stored.snapshot.state, 'completed'); assert.equal(stored.snapshot.lastSequence, completed.sequence);
    assert.ok(stored.snapshot.messages.some(message => message.role === 'tool' && message.toolCallId === 'repair-source'));
    assert.deepEqual(stored.events, events);
    let last = completed;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = parseEventLines((await runCli(['resume', completed.sessionId, '--json'], workspace)).stdout);
      assert.equal(resumed[0].type, 'session.restored'); assert.equal(resumed[0].sequence, last.sequence + 1);
      assert.equal(resumed[0].payload.replayed, false); assert.equal(resumed[0].payload.permissions, 'full-access');
      assert.equal(resumed.at(-1).type, 'execution.completed'); assert.deepEqual(resumed.at(-1).payload, completed.payload);
      assert.ok(resumed.every(event => event.sessionId === completed.sessionId && !event.type.startsWith('tool.')));
      last = resumed.at(-1);
    }
    assert.equal(planningRequests, 1); assert.equal(codingRequests, 5); assert.deepEqual(errors, []);
    await assertFiles(); assert.equal(await readFile(join(workspace, '.verification-count'), 'utf8'), '3');
    const restored = readDatabase(databasePath, completed.sessionId);
    assert.equal(restored.snapshot.lastSequence, last.sequence); assert.deepEqual(restored.events.at(-1), last);
    assert.equal(await realpath(restored.snapshot.workspace), workspace);
    return { modelSource: 'loopback HTTP fixture, not a live provider', codingRequests, toolCalls: events.filter(event => event.type === 'tool.started').length, verificationExitCodes: reports.map(report => report.checks[0].exitCode), restoredWithoutReplay: true };
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(() => done()));
  }
}
