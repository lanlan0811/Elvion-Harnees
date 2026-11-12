import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const version = process.argv[2];
const output = path.resolve('artifacts/release');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.version !== version || !/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Release package version mismatch.');
await mkdir(output, { recursive: true });
for (const arch of ['x64', 'arm64']) {
  const name = 'elvion-harnees-win32-' + arch;
  pkg.optionalDependencies[name] = version;
  const tarball = name + '-' + version + '.tgz';
  await access(path.join(output, tarball));
}
delete pkg.workspaces;
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
// Mutates only the disposable release checkout, never the repository or lockfile.
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], { stdio: 'inherit', shell: process.platform === 'win32' });
for (const name of ['portablegit-corresponding-sources.tar.gz', 'sources-manifest.json', 'source-provenance.json']) await copyFile(path.join('artifacts/sources', name), path.join(output, name));
await copyFile('release/release-' + version + '.md', path.join(output, 'release-' + version + '.md'));
const files = (await readdir(output)).filter(name => name !== 'SHA256SUMS').sort();
const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(output, file))) hash.update(chunk);
  lines.push(hash.digest('hex') + '  ' + file);
}
await writeFile(path.join(output, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log('Prepared release artifacts for ' + version);
