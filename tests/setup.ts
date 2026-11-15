import { build } from 'esbuild';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export default async function setup(): Promise<void> {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: resolve('.'), stdio: 'pipe' });
  await build({ entryPoints: ['packages/session/src/worker.ts'], outfile: 'dist/session-worker.js', bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', plugins: [{ name: 'workspace', setup(builder) { builder.onResolve({ filter: /^@elvion\// }, args => ({ path: resolve('packages', args.path.slice('@elvion/'.length), 'src/index.ts') })); } }] });
}
