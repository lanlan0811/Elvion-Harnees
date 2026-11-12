// macOS local command lifecycle helper; it does not perform agent work.
import { spawn } from 'node:child_process';

const [bash, cwd, command] = process.argv.slice(2);
if (!bash || !cwd || command === undefined || process.platform !== 'darwin') process.exit(125);
const child = spawn(bash, ['--noprofile', '--norc', '-c', command], { cwd, env: process.env, shell: false, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
function signalGroup(signal: NodeJS.Signals): void { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } } }
function stop(): void {
  if (stopping) return; stopping = true;
  signalGroup('SIGTERM');
  setTimeout(() => { signalGroup('SIGKILL'); process.exit(130); }, 2000);
}
process.stdin.resume(); process.stdin.on('end', stop); process.stdin.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', error => { process.stderr.write(error.message); process.exit(125); });
child.on('exit', code => { signalGroup('SIGTERM'); setTimeout(() => { signalGroup('SIGKILL'); process.exit(code ?? 130); }, 50); });
