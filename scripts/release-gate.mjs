/* global AbortSignal */
import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const version = process.argv[2];
if (!/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$|^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Release version must be an exact stable semver without v prefix.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.version !== version) throw new Error('Release version does not match package.json.');
const notes = await readFile('release/release-' + version + '.md', 'utf8');
if (!notes.includes(version) || notes.trim().length < 100) throw new Error('Versioned release notes are missing or incomplete.');
await access('LICENSE');
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const sha = process.env.GITHUB_SHA;
if (!repository || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !token || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Release gate requires GitHub repository, token, and exact commit SHA.');
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run from main.');
const localSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (localSha !== sha) throw new Error('Checkout does not match the release SHA.');
const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(route) {
  const response = await fetch('https://api.github.com/repos/' + repository + route, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('GitHub release gate API failed: HTTP ' + response.status);
  return response.json();
}
const branch = await api('/branches/main');
if (branch.commit?.sha !== sha) throw new Error('main has changed; dispatch a new release for its current head.');
const runs = await api('/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=' + sha + '&per_page=100');
const candidates = runs.workflow_runs?.filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === 'main') ?? [];
const latest = candidates.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error('Exact main SHA must have a completed successful CI push run.');
console.log('Release gate passed: ' + version + ' / ' + sha + ' / CI run ' + latest.id);
