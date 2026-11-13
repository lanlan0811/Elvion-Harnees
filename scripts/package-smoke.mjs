import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm run test:package');
function run(command, args, cwd = root) { return new Promise((resolvePromise, reject) => { const child = spawn(command, args, { cwd, env: { ...process.env, ELVION_HOME: join(temp, 'isolated-home') }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); child.on('error', reject); child.on('exit', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} failed (${code}): ${stderr} ${stdout}`))); }); }
const npmRun = (args, cwd = root) => run(process.execPath, [npmCli, ...args], cwd);
const temp = await mkdtemp(join(tmpdir(), 'elvion 安装验收 '));
try {
  console.log('Packing CLI and platform archives for an isolated npm installation...');
  await mkdir('artifacts', { recursive: true });
  const packed = JSON.parse(await npmRun(['pack', '--ignore-scripts', '--json', '--pack-destination', 'artifacts']));
  const tarball = resolve('artifacts', packed[0].filename);
  await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'elvion-package-smoke', private: true }));
  const staged = join(temp, 'staged'); await mkdir(staged);
  await copyFile(tarball, join(staged, 'cli.tgz'));
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  // cwd is passed through the Unicode OS API; tar arguments stay ASCII even
  // on an English Windows runner with a legacy console code page.
  await run(tar, ['-xf', 'cli.tgz'], staged);
  const packageRoot = join(staged, 'package'); const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Consume actual packed files; local development file: deps become registry versions.
  delete manifest.workspaces; delete manifest.devDependencies;
  manifest.optionalDependencies = {};
  if (process.platform === 'win32') {
    const platformName = `elvion-harnees-win32-${process.arch}`;
    const platformPacked = JSON.parse(await npmRun(['pack', `./packages/platform-win32-${process.arch}`, '--ignore-scripts', '--json', '--pack-destination', 'artifacts']));
    manifest.optionalDependencies[platformName] = 'file:' + resolve('artifacts', platformPacked[0].filename).replaceAll('\\', '/');
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log('Installing packed archives with lifecycle scripts disabled...');
  await npmRun(['install', '--install-links', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', packageRoot], temp);
  console.log('Checking relocated CLI assets and executing its installed Bash...');
  const installed = join(temp, 'node_modules', 'elvion-harnees');
  const binary = join(installed, 'dist', 'cli', 'index.js');
  const version = await run(process.execPath, [binary, '--version'], temp); if (version.trim() !== '0.1.0') throw new Error('Installed CLI version mismatch');
  const help = await run(process.execPath, [binary, '--help'], temp); if (!help.includes('resume')) throw new Error('Installed help missing');
  const preview = await run(process.execPath, [binary, '--preview', '160', '48'], temp); if (!/[\u2800-\u28ff]/u.test(preview)) throw new Error('Installed fox asset missing');
  const doctor = await run(process.execPath, [binary, 'doctor'], temp); if (!doctor.includes('[通过] Bash')) throw new Error('Installed Bash unavailable');
  console.log('Checking installed prompts and initial context from an unrelated workspace...');
  const promptWorkspace = join(temp, '工作目录 含空格'); await mkdir(join(promptWorkspace, 'prompts'), { recursive: true });
  for (const name of ['system.md', 'agent.md', 'tools.md']) await writeFile(join(promptWorkspace, 'prompts', name), 'cwd-prompt-must-not-load-' + name);
  const verifyPrompts = String.raw`
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    const { AgentRuntime } = await import(process.argv[1]);
    const { SessionStore } = await import(process.argv[2]);
    const expected = [];
    for (const name of ['system.md', 'agent.md', 'tools.md']) {
      const built = await readFile(new URL(name, process.argv[3]), 'utf8');
      const source = await readFile(new URL(name, process.argv[4]), 'utf8');
      assert.equal(built, source, 'Installed prompt copies differ: ' + name);
      assert.ok(built.trim(), 'Installed prompt is empty: ' + name);
      expected.push(built.trim());
    }
    const profile = { id: 'package-prompts', name: 'Package prompt check', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'package-smoke-fake-key', model: 'fixture-model', contextWindow: 100000, maxOutputTokens: 5000 };
    const store = await SessionStore.create(process.cwd(), process.argv[5]);
    let agent; let factoryCalls = 0; let requests = 0;
    try {
      agent = new AgentRuntime({ store, config: { version: 1, profiles: [profile], activeProfileId: profile.id }, executor: { definitions: [], execute: async () => { throw Error('Unexpected tool execution'); } }, providerFactory: () => {
        factoryCalls++;
        return { async *stream(request) {
          requests++;
          const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
          let previous = -1;
          for (const prompt of expected) {
            const index = system.indexOf(prompt);
            assert.ok(index > previous, 'Installed system, agent and tools prompts must be included in order');
            assert.equal(system.split(prompt).length, 2, 'Installed prompt must occur exactly once');
            previous = index;
          }
          assert.ok(!system.includes('cwd-prompt-must-not-load-'), 'Workspace prompts must not replace application instructions');
          yield { type: 'text', text: 'verified installed prompts' };
          yield { type: 'done', reason: 'stop' };
        } };
      } });
      await agent.ready();
      assert.equal(factoryCalls, 0, 'Initialization must not construct a provider');
      assert.equal(requests, 0, 'Initialization must not send a model request');
      const initial = agent.getSnapshot();
      assert.ok(Number.isFinite(initial.contextPercent) && initial.contextPercent > 0, 'Installed prompts must contribute to initial context usage');
      assert.equal(initial.estimated, true, 'Initial context usage must be labeled as estimated');
      await agent.send('Check installed application instructions.');
      assert.equal(factoryCalls, 1); assert.equal(requests, 1, 'Installed runtime must pass the prompt check through its provider request');
      assert.equal(agent.getSnapshot().status, 'idle', agent.getSnapshot().error);
      console.log('Installed prompt loading and initial context verified.');
    } finally { if (agent) await agent.close(); else await store.close(); }
  `;
  await run(process.execPath, ['--input-type=module', '-e', verifyPrompts, pathToFileURL(join(installed, 'dist', 'runtime', 'agent.js')).href, pathToFileURL(join(installed, 'dist', 'runtime', 'session.js')).href, pathToFileURL(join(installed, 'dist', 'prompts') + '/').href, pathToFileURL(join(installed, 'prompts') + '/').href, join(temp, 'prompt-session-home')], promptWorkspace);
  const execute = "const {runBash}=await import(process.argv[1]);const r=await runBash({command:'printf elvion-packed-runtime',cwd:process.argv[2],signal:new AbortController().signal,timeoutMs:15000});if(r.exitCode!==0||r.stdout!=='elvion-packed-runtime')throw Error('Installed Bash execution failed: '+JSON.stringify(r));";
  await run(process.execPath, ['--input-type=module', '-e', execute, pathToFileURL(join(installed, 'dist', 'execution', 'bash.js')).href, temp], temp);
  if (process.platform === 'win32') {
    const platform = join(temp, 'node_modules', `elvion-harnees-win32-${process.arch}`);
    await rename(platform, platform + '.missing');
    try {
      let rejected = false;
      try { await run(process.execPath, [binary, 'doctor'], temp); } catch (e) { if (!String(e).includes('缺少完整 Bash 平台包')) throw e; rejected = true; }
      if (!rejected) throw new Error('Missing Windows optional runtime must fail instead of falling back');
    } finally { await rename(platform + '.missing', platform); }
  }
  console.log('Packed CLI and platform smoke passed: script-free npm tarball installation, relocated Chinese/spaced path, version/help/fox/prompts/context/Bash.');
} finally { await rm(temp, { recursive: true, force: true }); }
