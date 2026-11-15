import { build } from 'esbuild';
import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
const workspacePlugin = { name: 'workspace', setup(builder) { builder.onResolve({ filter: /^@elvion\// }, args => ({ path: resolve('packages', args.path.slice('@elvion/'.length), 'src/index.ts') })); } };
const options = { bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true, plugins: [workspacePlugin] };
await build({ ...options, entryPoints: ['packages/session/src/worker.ts'], outfile: 'dist/session-worker.js' });
for (const entry of await readdir('packages', { withFileTypes: true })) {
  const source = `packages/${entry.name}/src/index.ts`;
  if (!entry.isDirectory()) continue;
  await build({ ...options, entryPoints: [source], outfile: `dist/packages/${entry.name}/index.js` });
}
const cli = 'apps/cli/src/index.tsx';
{
  await build({ ...options, entryPoints: [cli], outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } });
  await mkdir('dist/assets/brand', { recursive: true });
  for (const file of await readdir('assets/brand')) await copyFile(`assets/brand/${file}`, `dist/assets/brand/${file}`);
}
const cliPackage = JSON.parse(await readFile('apps/cli/package.json', 'utf8'));
const dependencies = Object.fromEntries(Object.entries(cliPackage.dependencies).filter(([name]) => !name.startsWith('@elvion/')));
dependencies.zod = '^4.1.12';
await writeFile('dist/package.json', JSON.stringify({ name: 'elvion', version: cliPackage.version, description: 'Independent coding engine with a native terminal UI', type: 'module', bin: { elvion: './cli.js' }, engines: { node: '>=24 <25' }, files: ['cli.js', 'cli.js.map', 'session-worker.js', 'session-worker.js.map', 'assets', 'README.md'], dependencies }, null, 2));
await copyFile('README.md', 'dist/README.md');
console.log('Built CLI, SQLite worker, packages and brand assets.');
