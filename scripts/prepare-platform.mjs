// Build-time only. No consumer install scripts or runtime downloads.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const architecture = process.argv.find(argument => argument.startsWith('--arch='))?.split('=')[1] ?? process.arch;
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(architecture)) throw new Error('PortableGit preparation requires a Windows build machine and x64/arm64 target.');
const version = '2.56.1';
const digest = architecture === 'x64' ? '9dd04a608ceb5f6ab32a73709e0ecb159d211da71b697c45ff81f6dd0c6b49c7' : '0dca0d9f760924a7e6752235d7dd6eb1a9b508ee714b6ed15d89252e5a58c5c9';
const archiveName = `PortableGit-${version}-${architecture === 'x64' ? '64-bit' : 'arm64'}.7z.exe`;
const url = `https://github.com/git-for-windows/git/releases/download/v${version}.windows.1/${archiveName}`;
const cache = path.join(root, '.cache', 'portablegit');
const target = path.join(root, 'packages', `platform-win32-${architecture}`);
const runtime = path.join(target, 'runtime');
await mkdir(cache, { recursive: true }); await mkdir(target, { recursive: true });
const archive = path.join(cache, archiveName);
try { await access(archive); } catch {
  console.log(`Downloading pinned official PortableGit ${version} ${architecture} ...`);
  const response = await fetch(url); if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
}
const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
if (actual !== digest) throw new Error(`PortableGit checksum mismatch: ${actual}`);
function run(file, args, cwd = root) { return new Promise((resolve, reject) => { const child = spawn(file, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`))); }); }
try { await access(path.join(runtime, 'bin', 'bash.exe')); } catch {
  // PortableGit is the upstream SFX: -y/-o select noninteractive extraction and it
  // runs its own post-install.bat. No modifications to users' machine Git/PATH.
  await run(archive, ['-y', `-o${runtime}`]);
}
await access(path.join(runtime, 'bin', 'bash.exe'));
// The SFX initialization can delete post-install.bat. Only an extant script is
// run again; then verify the actual programs instead of trusting the cache.
try {
  await access(path.join(runtime, 'post-install.bat'));
  await run(process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe', ['/d', '/c', 'post-install.bat'], runtime);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await run(path.join(runtime, 'bin', 'bash.exe'), ['--noprofile', '--norc', '-c', 'test -x /usr/bin/bash && /cmd/git.exe --version']);
const provenance = { version: `${version}.windows.1`, architecture, source: url, sha256: digest, licenseSource: 'https://github.com/git-for-windows/build-extra/blob/main/get-sources.sh', preparedAt: new Date().toISOString() };
await writeFile(path.join(target, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
await writeFile(path.join(target, 'THIRD_PARTY.md'), `# PortableGit ${version}.windows.1\n\nThis complete runtime is the official Git for Windows PortableGit distribution.\nAll original license, copyright and source-offer files inside runtime/ are retained.\nGit, Bash, MSYS2 and other components retain their own licenses; they are not relicensed as MIT.\nExact upstream binary: ${url}\nSHA-256: ${digest}\n\nRedistribution must accompany the matching third-party source bundle and build materials in the GitHub Release.\nUse the upstream build-extra/get-sources.sh collector at the pinned build-extra revision recorded in release provenance.\nRelease must fail if its corresponding-sources artifact is missing.\n`);
if (!process.argv.includes('--skip-launcher')) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'build-launcher.ps1'), '-Architecture', architecture]);
if (process.argv.includes('--skip-launcher')) console.log('Runtime prepared; launcher build intentionally deferred. This is not a complete platform package.');
else { await access(path.join(target, 'bin', 'elvion-job.exe')); console.log(`Platform package prepared: ${target}`); }
// Keep the original archive checksum alongside published provenance.
await copyFile(path.join(target, 'provenance.json'), path.join(cache, `provenance-${architecture}.json`));
