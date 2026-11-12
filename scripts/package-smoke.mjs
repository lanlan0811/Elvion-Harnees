import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm run test:package');
function run(command, args, cwd = root) { return new Promise((resolvePromise, reject) => { const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); child.on('error', reject); child.on('exit', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} failed (${code}): ${stderr} ${stdout}`))); }); }
const npmRun = (args, cwd = root) => run(process.execPath, [npmCli, ...args], cwd);
const temp = await mkdtemp(join(tmpdir(), 'elvion 安装验收 '));
try {
  await mkdir('artifacts', { recursive: true });
  const packed = JSON.parse(await npmRun(['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts']));
  const tarball = resolve('artifacts', packed[0].filename);
  await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'elvion-package-smoke', private: true }));
  const staged = join(temp, 'staged'); await mkdir(staged); await run('tar', ['-xf', tarball, '-C', staged]);
  const packageRoot = join(staged, 'package'); const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Consume actual packed files; local development file: deps become registry versions.
  delete manifest.workspaces; delete manifest.devDependencies;
  manifest.optionalDependencies = Object.fromEntries(Object.keys(manifest.optionalDependencies || {}).map(name => [name, manifest.version]));
  await writeFile(manifestPath, JSON.stringify(manifest));
  await npmRun(['install', '--install-links', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', packageRoot], temp);
  const installed = join(temp, 'node_modules', 'elvion-harnees');
  if (process.platform === 'win32') {
    const platform = `elvion-harnees-win32-${process.arch}`; const target = join(temp, 'node_modules', platform);
    await cp(join(root, 'packages', `platform-win32-${process.arch}`), target, { recursive: true });
  }
  const binary = join(installed, 'dist', 'cli', 'index.js');
  const version = await run(process.execPath, [binary, '--version'], temp); if (version.trim() !== '0.1.0') throw new Error('Installed CLI version mismatch');
  const help = await run(process.execPath, [binary, '--help'], temp); if (!help.includes('resume')) throw new Error('Installed help missing');
  const preview = await run(process.execPath, [binary, '--preview', '160', '48'], temp); if (!/[\u2800-\u28ff]/u.test(preview)) throw new Error('Installed fox asset missing');
  const doctor = await run(process.execPath, [binary, 'doctor'], temp); if (!doctor.includes('[通过] Bash')) throw new Error('Installed Bash unavailable');
  console.log('Packed CLI smoke passed: script-free installation, relocated Chinese/spaced path, version/help/fox/Bash.');
} finally { await rm(temp, { recursive: true, force: true }); }
