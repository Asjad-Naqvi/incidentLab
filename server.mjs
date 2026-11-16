import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStore } from './lib/store.mjs';
import { checkout, replayIncident } from './lib/service.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export function createApp(store) {
  const clients = new Set();
  let busy = false;
  const notify = () => { for (const res of clients) res.write('data: update\n\n'); };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      // Local dashboard mutation endpoints must not be callable cross-origin.
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'Cross-origin mutation rejected' });
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
        return res.end(await readFile(join(root, 'public', file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('data: connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') return json(200, { metrics: store.metrics(), incidents: store.incidents(), timeline: store.timeline(), fixed: store.isFixed() });
      const match = url.pathname.match(/^\/api\/incidents\/([a-z0-9-]+)(\/replay|\/resolve)?$/);
      if (match) {
        const incident = store.incident(match[1]);
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
          if (!latest || latest.afterErrors !== 0 || !latest.fixed || !store.isFixed() || !currentEvidence) return json(409, { error: 'Apply the demo fix and successfully replay the current captured failures before resolving.' });
          store.resolve(match[1]); notify(); return json(200, { ok: true });
        }
      }
      if (req.method === 'POST' && ['/api/demo/traffic', '/api/demo/fix', '/api/demo/break', '/demo/checkout'].includes(url.pathname)) {
        if (busy) return json(409, { error: 'Another fixture operation is running. Try again shortly.' });
        busy = true;
        try {
          if (url.pathname === '/api/demo/fix' || url.pathname === '/api/demo/break') {
            store.setFixed(url.pathname.endsWith('/fix')); notify(); return json(200, { fixed: store.isFixed() });
          }
          if (url.pathname === '/api/demo/traffic') {
            for (let i = 0; i < 12; i++) {
              const payload = { fixture: i % 3 === 0 ? 'expired-session' : 'valid-session', amount: 49 };
              const result = await checkout(payload, store.isFixed());
              store.record({ method: 'POST', path: '/demo/checkout', ...result, payload });
            }
            notify(); return json(200, { generated: 12 });
          }
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(413, { error: 'Payload too large' }); }
          const input = JSON.parse(body || '{}');
          if (!input || typeof input !== 'object' || !['valid-session', 'expired-session'].includes(input.fixture)) return json(400, { error: 'Use a valid-session or expired-session fixture' });
          // Persist only allowlisted fixture fields, never credentials or arbitrary request data.
          const payload = { fixture: input.fixture, amount: 49 };
          const result = await checkout(payload, store.isFixed());
          store.record({ method: 'POST', path: '/demo/checkout', ...result, payload }); notify();
          return json(result.status, result.body);
        } finally { busy = false; }
      }
      json(404, { error: 'Not found' });
    } catch (error) {
      console.error(error.message);
      if (!res.headersSent) json(error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'Invalid JSON' : 'Internal server error' });
      else res.end();
    }
  });
  server.on('close', () => { clearInterval(heartbeat); for (const res of clients) res.end(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const store = createStore(join(root, 'data', 'incidentlab.sqlite'));
  const server = createApp(store);
  const port = Number(process.env.PORT || 4317);
  server.listen(port, '127.0.0.1', () => console.log(`IncidentLab ready at http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
  const stop = () => { server.close(() => { store.close(); process.exit(0); }); server.closeAllConnections(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
