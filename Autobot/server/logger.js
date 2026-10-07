const secretKeys = /^(password|token|authorization|cookie|secret|api[_-]?key|.*_api_key)$/i;
export function redact(value) {
  let text = String(value ?? '');
  for (const secret of [process.env.DEEPSEEK_API_KEY]) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\d{5,}:[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
function safe(value, key = '') {
  if (secretKeys.test(key)) return '[REDACTED]';
  if (value instanceof Error) return { message: redact(value.message), stack: redact(value.stack), code: value.code };
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => safe(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v, k)]));
  return value;
}
// fetch wraps DNS, socket and TLS failures in a generic TypeError.
// AggregateError may contain a separate failure for each resolved address.
export function errorDetail(error, depth = 0) {
  if (!error || depth > 4) return '';
  const message = redact(error.message || String(error));
  const code = error.code ? `[${redact(error.code)}] ` : '';
  const nested = [error.cause, ...(Array.isArray(error.errors) ? error.errors : [])]
    .map(cause => errorDetail(cause, depth + 1)).filter(Boolean);
  return [...new Set([`${code}${message}`, ...nested])].join('; ').slice(0, 6000);
}
export function log(level, message, fields = {}) {
  const entry = JSON.stringify({ time: new Date().toISOString(), level, message: redact(message), ...safe(fields) });
  (level === 'error' ? console.error : console.log)(entry);
}
