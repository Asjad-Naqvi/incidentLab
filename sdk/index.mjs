import { randomUUID } from 'node:crypto';
import { normalizeEvent } from './telemetry.mjs';

/** Bounded, best-effort server-side telemetry client. Never use API keys in browser code. */
export function createClient({ endpoint, apiKey, service, payloadKeys = [], capacity = 500,
  maxAttempts = 3, retryDelayMs = 100, flushIntervalMs = 1000, timeoutMs = 3000,
  fetchImpl = fetch, onError = () => {} }) {
  const url = new URL('/api/v1/events', endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for remote telemetry');
  if (!apiKey || !/^[a-z][a-z0-9-]{0,63}$/.test(service)) throw new Error('An API key and valid service name are required');
  if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Invalid queue or retry configuration');
  let queue = [];
  let inFlight = null;
  let closed = false;
  const report = code => { try { onError(new Error(code)); } catch { /* Telemetry callbacks must not break application requests. */ } };
  const client = {
    capture(input) {
      if (closed || queue.length >= capacity) { report(closed ? 'Telemetry client closed' : 'Telemetry queue full'); return false; }
      try {
        const payload = Object.fromEntries(payloadKeys.filter(key => Object.hasOwn(input.payload ?? {}, key)).map(key => [key, input.payload[key]]));
        const safe = normalizeEvent({ ...input, id: input.id ?? randomUUID(), service, payload });
        // The wire schema uses errorType; database representation uses error.
        const { error, source, ...event } = safe;
        queue.push({ ...event, errorType: error });
        return true;
      } catch { report('Invalid telemetry event'); return false; }
    },
    flush() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const pending = queue.length; // Captures added during a flush wait for the next one.
        let delivered = 0;
        while (delivered < pending && queue.length) {
          const batch = queue.slice(0, Math.min(25, pending - delivered));
          // Count UTF-8 bytes, not JavaScript characters, against the collector's body limit.
          while (batch.length > 1 && Buffer.byteLength(JSON.stringify({ events: batch })) > 60 * 1024) batch.pop();
          const body = JSON.stringify({ events: batch });
          let accepted = false;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let retryable = true;
            try {
              const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body, signal: AbortSignal.timeout(timeoutMs) });
              await response.arrayBuffer();
              if (response.status === 202) { accepted = true; break; }
              retryable = [408, 429].includes(response.status) || response.status >= 500;
            } catch { /* Network failures retain the same event IDs for idempotent retries. */ }
            if (!retryable) { report('Telemetry rejected; check credentials and schema'); return { delivered, pending: queue.length }; }
            if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, Math.min(5000, retryDelayMs * 2 ** attempt)));
          }
          if (!accepted) { report('Telemetry delivery deferred'); break; }
          queue.splice(0, batch.length); delivered += batch.length;
        }
        return { delivered, pending: queue.length };
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
    get pending() { return queue.length; },
    async close() { closed = true; clearInterval(timer); return client.flush(); }
  };
  const timer = flushIntervalMs > 0 ? setInterval(() => { void client.flush(); }, flushIntervalMs) : null;
  timer?.unref();
  return client;
}
