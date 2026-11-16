import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openStore } from './lib/open-store.mjs';
import { checkout, replayIncident } from './lib/service.mjs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { normalizeEvent, ValidationError } from './sdk/telemetry.mjs';
import { startWorker } from './lib/worker.mjs';
import { localIngestionKey } from './lib/config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/integrations.css': ['integrations.css', 'text/css'] };
async function readJSON(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createApp(store, { ingestionKey, workerEnabled = true } = {}) {
  const clients = new Set();
  let busy = false;
  const notify = () => { for (const res of clients) res.write('data: update\n\n'); };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  const worker = workerEnabled ? startWorker(store, { onUpdate: notify }) : null;
  // A separately deployed worker has no in-process callback. Refresh subscribed dashboards.
  const externalUpdates = !workerEnabled ? setInterval(notify, 2000) : null;
  externalUpdates?.unref();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      // Local dashboard mutation endpoints must not be callable cross-origin.
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'Cross-origin mutation rejected' });
      if (req.method === 'GET' && url.pathname === '/healthz') { await store.ping(); return json(200, { status: 'ok', storage: store.backend }); }
      if (req.method === 'POST' && url.pathname === '/api/v1/events') {
        if (!ingestionKey) return json(503, { error: 'Ingestion is not configured' });
        const header = req.headers.authorization || '';
        const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
        const digest = value => createHash('sha256').update(value).digest();
        if (!timingSafeEqual(digest(supplied), digest(ingestionKey))) return json(401, { error: 'Invalid ingestion credential' });
        const input = await readJSON(req, 65536);
        if (!Array.isArray(input?.events) || input.events.length < 1 || input.events.length > 25) return json(400, { error: 'Provide between 1 and 25 events' });
        const events = input.events.map(normalizeEvent);
        if (events.some(event => event.service === 'checkout-api')) return json(400, { error: 'checkout-api is reserved for the built-in replay fixture' });
        const result = await store.enqueueBatch(events);
        notify(); return json(202, result);
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
        return res.end(await readFile(join(root, 'public', file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('data: connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const [metrics, incidents, timeline, fixed, queue, services] = await Promise.all([
          store.metrics(), store.incidents(), store.timeline(), store.isFixed(), store.queueStats(), store.services()
        ]);
        return json(200, { metrics, incidents, timeline, fixed, ingestion: {
          enabled: Boolean(ingestionKey), queue, services, storage: store.backend, workerMode: workerEnabled ? 'embedded' : 'external'
        } });
      }
      const match = url.pathname.match(/^\/api\/incidents\/([a-z0-9-]+)(\/replay|\/resolve)?$/);
      if (match) {
        const incident = await store.incident(match[1]);
        if (!incident) return json(404, { error: 'Incident not found' });
        if (req.method === 'GET' && !match[2]) return json(200, incident);
        if (req.method === 'POST' && match[2] === '/replay') {
          if (busy) return json(409, { error: 'Another fixture operation is running. Try again shortly.' });
          busy = true;
          try { const result = await replayIncident(store, match[1]); notify(); return json(200, result); } finally { busy = false; }
        }
        if (req.method === 'POST' && match[2] === '/resolve') {
          const latest = incident.replays[0];
          const currentIds = incident.events.filter(e => e.path === '/demo/checkout' && e.method === 'POST').slice(0, 100).map(e => e.id);
          const verifiedIds = new Set(latest?.results.map(r => r.eventId));
          const currentEvidence = currentIds.length > 0 && currentIds.length === verifiedIds.size && currentIds.every(id => verifiedIds.has(id));
          if (incident.service !== 'checkout-api' || !latest || latest.afterErrors !== 0 || !latest.fixed || !await store.isFixed() || !currentEvidence) return json(409, { error: 'Apply the demo fix and successfully replay the current captured failures before resolving.' });
          await store.resolve(match[1]); notify(); return json(200, { ok: true });
        }
      }
      if (req.method === 'POST' && ['/api/demo/traffic', '/api/demo/fix', '/api/demo/break', '/demo/checkout'].includes(url.pathname)) {
        if (busy) return json(409, { error: 'Another fixture operation is running. Try again shortly.' });
        busy = true;
        try {
          if (url.pathname === '/api/demo/fix' || url.pathname === '/api/demo/break') {
            await store.setFixed(url.pathname.endsWith('/fix')); notify(); return json(200, { fixed: await store.isFixed() });
          }
          if (url.pathname === '/api/demo/traffic') {
            for (let i = 0; i < 12; i++) {
              const payload = { fixture: i % 3 === 0 ? 'expired-session' : 'valid-session', amount: 49 };
              const result = await checkout(payload, await store.isFixed());
              await store.record({ method: 'POST', path: '/demo/checkout', ...result, payload });
            }
            notify(); return json(200, { generated: 12 });
          }
          const input = await readJSON(req, 4096);
          if (!input || typeof input !== 'object' || !['valid-session', 'expired-session'].includes(input.fixture)) return json(400, { error: 'Use a valid-session or expired-session fixture' });
          // Persist only allowlisted fixture fields, never credentials or arbitrary request data.
          const payload = { fixture: input.fixture, amount: 49 };
          const result = await checkout(payload, await store.isFixed());
          await store.record({ method: 'POST', path: '/demo/checkout', ...result, payload }); notify();
          return json(result.status, result.body);
        } finally { busy = false; }
      }
      json(404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof SyntaxError || error instanceof ValidationError ? 400 : (error.status || 500);
      if (status === 500) console.error('Request processing failed');
      if (!res.headersSent) json(status, { error: error instanceof SyntaxError ? 'Invalid JSON' : status === 500 ? 'Internal server error' : error.message });
      else res.end();
    }
  });
  server.stopWorker = async () => { await worker?.stop(); };
  server.on('close', () => { clearInterval(heartbeat); clearInterval(externalUpdates); void worker?.stop(); for (const res of clients) res.end(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const store = await openStore();
  const server = createApp(store, { ingestionKey: localIngestionKey(), workerEnabled: process.env.INCIDENTLAB_WORKER_MODE !== 'external' });
  const port = Number(process.env.PORT || 4317);
  const host = process.env.INCIDENTLAB_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`IncidentLab ready at http://${host}:${port} (${store.backend})`));
  server.on('error', async error => { console.error(error.message); await server.stopWorker(); await store.close(); process.exitCode = 1; });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stopWorker(); server.close(async () => { await store.close(); process.exit(0); }); server.closeAllConnections();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.on('message', message => { if (message === 'shutdown') void stop(); });
}
