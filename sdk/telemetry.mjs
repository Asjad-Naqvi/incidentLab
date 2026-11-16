const secretKey = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credit[-_]?card|card[-_]?number|email|phone|address/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function redact(value, depth = 0) {
  if (depth > 4) return '[depth limit]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 256)
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted]')
    .replace(/\b(?:sk|ghp|github_pat)[_-][\w-]+/g, '[redacted]');
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20)
    .map(([key, entry]) => [key.slice(0, 64), secretKey.test(key) ? '[redacted]' : redact(entry, depth + 1)]));
  return null;
}

export class ValidationError extends Error {}

export function normalizeEvent(input) {
  const invalid = message => { throw new ValidationError(message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Each event must be an object');
  if (typeof input.id !== 'string' || !uuid.test(input.id)) invalid('Event id must be a UUID');
  if (typeof input.service !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.service)) invalid('Invalid service name');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(input.method)) invalid('Invalid HTTP method');
  // Send a route template, never a full URL, query string, or concrete customer identifier.
  if (typeof input.path !== 'string' || !/^\/[a-zA-Z0-9/_:.*-]{0,255}$/.test(input.path)) invalid('Path must be a route template without a query string');
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) invalid('Invalid HTTP status');
  if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 3600000) invalid('Invalid request duration');
  if (input.errorType != null && (typeof input.errorType !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(input.errorType))) invalid('errorType must be a short error class, not a message');
  if (input.payload != null && (typeof input.payload !== 'object' || Array.isArray(input.payload))) invalid('Payload must be an object');
  const payload = redact(input.payload ?? {});
  if (JSON.stringify(payload).length > 4096) invalid('Sanitized payload is too large');
  return { id: input.id, service: input.service, method: input.method, path: input.path,
    status: input.status, durationMs: Math.round(input.durationMs * 10) / 10,
    error: input.status >= 500 ? (input.errorType || 'UnhandledServiceError') : null,
    payload, source: 'live' };
}
