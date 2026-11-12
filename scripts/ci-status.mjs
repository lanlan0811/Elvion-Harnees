/* global AbortSignal */
import { spawn } from 'node:child_process';
function git(args, input = '') { return new Promise((resolve, reject) => { const child = spawn('git', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }); let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.resume(); child.on('error', reject); child.on('exit', c => c === 0 ? resolve(out) : reject(new Error('Git credential lookup unavailable'))); child.stdin.end(input); }); }
const sha = process.argv[2] || (await git(['rev-parse', 'HEAD'])).trim();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected commit SHA');
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
try { const fields = Object.fromEntries((await git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n')).trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })); if (fields.password) headers.Authorization = 'Bearer ' + fields.password; } catch { /* public repositories can be inspected anonymously */ }
const response = await fetch(`https://api.github.com/repos/lanlan0811/Elvion-Harnees/actions/runs?head_sha=${sha}&per_page=10`, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error('CI API status ' + response.status);
const data = await response.json();
const runs = [];
for (const run of data.workflow_runs) { const jobsResponse = await fetch(run.jobs_url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) }); const jobs = jobsResponse.ok ? (await jobsResponse.json()).jobs : []; runs.push({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url, sha: run.head_sha, jobs: jobs.map(j => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, failedSteps: j.steps.filter(s => s.conclusion === 'failure').map(s => s.name) })) }); }
process.stdout.write(JSON.stringify({ sha, runs }, null, 2) + '\n');
