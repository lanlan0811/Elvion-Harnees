/* global AbortSignal */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const sourceUrl = process.argv[2];
const expected = process.argv[3]?.toLowerCase();
const target = path.resolve(process.argv[4] ?? 'artifacts/sources');
const url = new URL(sourceUrl);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Corresponding sources require public HTTPS URL without credentials/query and SHA-256.');
await mkdir(target, { recursive: true });
const archive = path.join(target, 'portablegit-corresponding-sources.tar.gz');
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(600_000) });
if (!response.ok || !response.body) throw new Error('Source download failed: HTTP ' + response.status);
let bytes = 0;
const hash = createHash('sha256');
async function* limit(source) {
  for await (const chunk of source) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 ** 3) throw new Error('Source bundle exceeds 4 GiB limit.');
    hash.update(chunk); yield chunk;
  }
}
await pipeline(limit(Readable.fromWeb(response.body)), createWriteStream(archive, { flags: 'wx' }));
const digest = hash.digest('hex');
if (digest !== expected) throw new Error('Corresponding sources checksum mismatch.');
if (bytes < 1024 * 1024) throw new Error('Corresponding sources bundle is implausibly small.');
const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 }).split('\n').filter(Boolean);
for (const entry of listing) {
  if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..') || /^[a-zA-Z]:/.test(entry)) throw new Error('Unsafe archive entry.');
}
if (!listing.includes('sources-manifest.json')) throw new Error('Source bundle requires root sources-manifest.json.');
const manifestText = execFileSync('tar', ['-xOzf', archive, '--', 'sources-manifest.json'], { encoding: 'utf8', maxBuffer: 2 * 1024 ** 2 });
const manifest = JSON.parse(manifestText);
if (manifest.schemaVersion !== 1 || manifest.portableGitVersion !== '2.56.1.windows.1' || !/^[a-f0-9]{40}$/.test(manifest.buildExtraCommit ?? '') || manifest.complete !== true || !Array.isArray(manifest.components)) throw new Error('Source manifest is incomplete or does not match bundled PortableGit.');
for (const required of ['git', 'bash', 'msys2-runtime']) if (!manifest.components.some(component => component.name === required)) throw new Error('Missing required source component: ' + required);
if (manifest.components.length < 4) throw new Error('Source manifest must inventory the entire runtime, including all other bundled components.');
const listed = new Set(listing);
const names = new Set();
for (const component of manifest.components) {
  if (!component || typeof component.name !== 'string' || names.has(component.name) || typeof component.version !== 'string' || !component.version || !Array.isArray(component.materials) || !component.materials.length) throw new Error('Invalid source component.');
  names.add(component.name);
  if (!Array.isArray(component.licenses) || !component.licenses.length || typeof component.buildInstructions !== 'string') throw new Error('Source component lacks licenses or build instructions.');
  const files = [...component.materials, ...component.licenses, component.buildInstructions];
  for (const item of files) {
    const filename = typeof item === 'string' ? item : item.path;
    if (typeof filename !== 'string' || filename.endsWith('/') || !listed.has(filename)) throw new Error('Missing source/license/build material: ' + filename);
  }
  for (const material of component.materials) {
    if (typeof material !== 'object' || !/^[a-f0-9]{64}$/.test(material.sha256 ?? '')) throw new Error('Source materials require individual SHA-256 digests.');
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xOzf', archive, '--', material.path], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      const itemHash = createHash('sha256'); let count = 0;
      child.stdout.on('data', chunk => { count += chunk.length; itemHash.update(chunk); });
      child.stderr.resume(); child.on('error', reject);
      child.on('exit', code => code === 0 && count > 0 && itemHash.digest('hex') === material.sha256 ? resolve() : reject(new Error('Source material checksum failed: ' + material.path)));
    });
  }
}
const platforms = ['x64', 'arm64'];
for (const arch of platforms) {
  const provenance = JSON.parse(await readFile('packages/platform-win32-' + arch + '/provenance.json', 'utf8'));
  if (provenance.version !== manifest.portableGitVersion) throw new Error('Platform/source version mismatch.');
  if (manifest.binaryArchives?.[arch]?.sha256 !== provenance.sha256) throw new Error('Source manifest must identify the exact bundled ' + arch + ' binary checksum.');
}
await writeFile(path.join(target, 'sources-manifest.json'), manifestText);
await writeFile(path.join(target, 'source-provenance.json'), JSON.stringify({ sourceUrl: url.href, sha256: digest, bytes, portableGitVersion: manifest.portableGitVersion, buildExtraCommit: manifest.buildExtraCommit, verifiedComponents: names.size }, null, 2) + '\n');
await access(archive);
console.log('Verified declared corresponding-source inventory and hashes: ' + names.size + ' components. Completeness requires release-owner audit.');
