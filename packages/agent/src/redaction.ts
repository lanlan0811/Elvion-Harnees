import type { JsonValue } from '@elvion/kernel';

/** Capture known secret values without ever adding the environment to model context. */
export function createSensitiveRedactor(env: NodeJS.ProcessEnv = process.env): {
  text(value: string): string;
  value<T>(value: T): T;
  stream(): { push(value: string): string; finish(): string };
} {
  const secrets = Object.entries(env)
    .filter(([name, value]) => /(?:key|token|secret|password|credential|authorization)/i.test(name) && value !== undefined && value.length >= 3)
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
  const text = (input: string): string => {
    let output = input;
    for (const secret of secrets) output = output.replaceAll(secret, '[REDACTED]');
    return output.replace(/Bearer\s+[A-Za-z0-9_.~+/-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  };
  const visit = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    return value;
  };
  return {
    text,
    value: <T>(value: T): T => visit(value as JsonValue) as T,
    stream: () => {
      const tailLength = Math.max(256, ...secrets.map(secret => secret.length));
      let pending = '';
      return {
        push: (part: string): string => {
          pending += part;
          let boundary = Math.max(0, pending.length - tailLength);
          for (const secret of secrets) {
            let start = pending.indexOf(secret);
            while (start !== -1) {
              if (start < boundary && start + secret.length > boundary) boundary = start;
              start = pending.indexOf(secret, start + secret.length);
            }
          }
          // Keep recognizable credentials together, including a token still arriving at the tail.
          for (const match of pending.matchAll(/(?:Bearer\s+|sk-|ghp_|github_pat_)[A-Za-z0-9_.~+/-]*/gi)) {
            if (match.index < boundary && match.index + match[0].length > boundary) boundary = match.index;
          }
          const safe = text(pending.slice(0, boundary));
          pending = pending.slice(boundary);
          return safe;
        },
        finish: (): string => { const safe = text(pending); pending = ''; return safe; },
      };
    },
  };
}
