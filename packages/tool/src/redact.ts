import type { JsonValue } from '@elvion/kernel';

export function createRedactor(): (text: string) => string {
  const secrets = Object.entries(process.env).filter(([name, value]) => /(?:key|token|secret|password|credential)/i.test(name) && value !== undefined && value.length >= 6).map(([, value]) => value!).sort((a, b) => b.length - a.length);
  return text => {
    let safe = text;
    for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED]');
    return safe.replace(/(?:Bearer\s+)[A-Za-z0-9_.~+/-]{8,}/gi, 'Bearer [REDACTED]').replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  };
}
export function boundedOutput(value: JsonValue, limit: number): { value: JsonValue; truncated: boolean } {
  const redact = createRedactor(); let remaining = limit; let truncated = false;
  const visit = (item: JsonValue): JsonValue => {
    if (typeof item === 'string') {
      const safe = redact(item); const result = safe.slice(0, Math.max(0, remaining));
      remaining -= result.length; if (result.length < safe.length) truncated = true; return result;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return { value: visit(value), truncated };
}
