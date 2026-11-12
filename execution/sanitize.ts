import stripAnsi from 'strip-ansi';

/** Terminal data is untrusted. Keep only printable text, tab and line endings. */
export function safeText(text: string, secrets: readonly string[] = []): string {
  let value = Array.from(stripAnsi(text)).filter(character => { const code = character.charCodeAt(0); return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159)); }).join('');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[REDACTED]');
  return value;
}

export function commandEnvironment(env: NodeJS.ProcessEnv = process.env, secrets: readonly string[] = []): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BASH_ENV|BASH_FUNC_|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|^ENV$|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|LD_PRELOAD|DYLD_|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_)/i.test(key)) continue;
    if (secrets.some(secret => secret && value.includes(secret))) continue;
    result[key] = value;
  }
  return { ...result, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', NO_COLOR: '1', TERM: 'dumb', BASH_ENV: '', ENV: '', LC_ALL: 'C.UTF-8' };
}
