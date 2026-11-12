import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
describe('legacy Windows PowerShell build compatibility', () => {
  it('launcher build script remains ASCII to avoid BOM-less UTF-8 misparsing', () => { const script = readFileSync(new URL('../scripts/build-launcher.ps1', import.meta.url), 'utf8'); expect([...script].every(c => c.charCodeAt(0) < 128)).toBe(true); });
  it.skipIf(process.platform !== 'win32')('parses under Windows PowerShell 5.1 without executing build commands', () => { const command = '$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts/build-launcher.ps1),[ref]$null,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}'; const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }); expect(result.status, result.stdout + result.stderr).toBe(0); });
});
