import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { verifyInstalledCoding } from './helpers/package-coding-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'elvion-package-'));
const npm = process.platform === 'win32' ? process.execPath : 'npm';
const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (process.platform === 'win32') await access(npmCli);
const environment = { ...process.env, ELVION_DATA_DIR: join(scratch, 'data'), NO_COLOR: '1', NODE_NO_WARNINGS: '1' };
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
const inheritedPath = process.env.PATH ?? '';
for (const name of Object.keys(environment)) if (name.toUpperCase() === 'PATH') delete environment[name];
environment.PATH = join(scratch, 'node_modules/.bin') + delimiter + inheritedPath;

async function run(executable, args, cwd, expectedExit = 0) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Package smoke command timed out: ${executable}`)); }, 180_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code !== expectedExit) reject(new Error(`${executable} exited ${code}, expected ${expectedExit}\n${stdout}\n${stderr}`)); else resolveResult({ stdout, stderr }); });
  });
}

try {
  const manifest = JSON.parse(await readFile(join(root, 'dist/package.json'), 'utf8'));
  assert.equal(manifest.name, 'elvion');
  assert.ok(Object.values(manifest.dependencies).every(version => typeof version === 'string' && !/workspace:|file:/.test(version)), 'Package must not depend on workspace/local paths');
  const packed = await run(npm, [...(process.platform === 'win32' ? [npmCli] : []), 'pack', '--json', '--pack-destination', artifacts], join(root, 'dist'));
  const entries = JSON.parse(packed.stdout);
  assert.equal(entries.length, 1);
  const tarball = join(artifacts, entries[0].filename);
  const files = new Set(entries[0].files.map(file => file.path));
  for (const required of ['cli.js', 'session-worker.js', 'assets/brand/elvion-fox-large.txt', 'assets/brand/elvion-fox-small.txt', 'assets/brand/elvion-wordmark.txt']) assert.ok(files.has(required), `Missing packaged resource ${required}`);
  await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'elvion-install-smoke', version: '1.0.0', private: true }));
  await run(npm, [...(process.platform === 'win32' ? [npmCli] : []), 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], scratch);
  const bin = join(scratch, 'node_modules/.bin', process.platform === 'win32' ? 'elvion.cmd' : 'elvion');
  await access(bin);
  const installed = join(scratch, 'node_modules/elvion/cli.js');
  assert.equal((await run(process.execPath, [installed, '--version'], scratch)).stdout.trim(), manifest.version);
  assert.match((await run(process.execPath, [installed, '--help'], scratch)).stdout, /Usage:[\s\S]*elvion run/);
  const doctor = JSON.parse((await run(process.execPath, [installed, 'doctor', '--json'], scratch, 2)).stdout);
  assert.equal(doctor.ready, false); assert.equal(doctor.version, manifest.version);
  assert.deepEqual(JSON.parse((await run(process.execPath, [installed, 'sessions', 'list', '--json'], scratch)).stdout), []);
  const list = JSON.parse((await run(process.execPath, [installed, 'providers', 'list', '--json'], scratch)).stdout); assert.deepEqual(list, []);
  for (const name of ['elvion-fox-large.txt', 'elvion-fox-small.txt', 'elvion-wordmark.txt']) assert.equal(await readFile(join(scratch, 'node_modules/elvion/assets/brand', name), 'utf8'), await readFile(join(root, 'assets/brand', name), 'utf8'));
  // npm exec resolves the independent installation's generated bin shim.
  // --offline and --no prevent package fetching or an implicit installation.
  const runNpm = (args, cwd) => run(npm, [...(process.platform === 'win32' ? [npmCli] : []), ...args], cwd);
  const runCli = (args, cwd) => runNpm(['exec', '--offline', '--no', '--prefix', scratch, '--', 'elvion', ...args, '--workspace', cwd], cwd);
  assert.equal((await runCli(['--version'], scratch)).stdout.trim(), manifest.version);
  const coding = await verifyInstalledCoding({ scratch, dataDirectory: environment.ELVION_DATA_DIR, runCli, runNpm });
  console.log(`Package smoke passed: ${tarball}; installed bin, version/help/doctor, resources, real cross-file edits and npm verification, SQLite worker and repeat resume verified. ${JSON.stringify(coding)}`);
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
