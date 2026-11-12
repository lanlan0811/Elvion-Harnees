import stripAnsi from 'strip-ansi';
export function sanitize(text: string, secrets: readonly string[] = []): string {
  let clean = stripAnsi(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[REDACTED]');
  return clean.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}
export function errorMessage(error: unknown, secrets: readonly string[] = []): string {
  return sanitize(error instanceof Error ? error.message : String(error), secrets);
}
