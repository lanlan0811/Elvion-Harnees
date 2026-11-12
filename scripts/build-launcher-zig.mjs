import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
const arch = process.argv.find(a => a.startsWith('--arch='))?.split('=')[1] || process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported launcher architecture');
const zig = process.env.ELVION_ZIG || '.cache/zig-x86_64-windows-0.15.2/zig.exe';
const directory = `packages/platform-win32-${arch}/bin`;
await mkdir(directory, { recursive: true });
const args = ['c++', '-target', arch === 'arm64' ? 'aarch64-windows-gnu' : 'x86_64-windows-gnu', '-municode', '-O2', '-static', 'native/windows-job.cpp', '-o', `${directory}/elvion-job.exe`];
await new Promise((resolve, reject) => { const child = spawn(zig, args, { shell: false, stdio: 'inherit', windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Native launcher compilation failed: ' + code))); });
