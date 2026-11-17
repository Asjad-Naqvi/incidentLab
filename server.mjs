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
import { createReplayRunner,replaySampleIncident } from './lib/isolated-replay.mjs';
import { createAuth } from './lib/auth.mjs';
import { securityHeaders,configureHttp,deploymentOrigin,shutdown } from './lib/http-security.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/login': ['login.html','text/html'], '/login.js': ['login.js','text/javascript'], '/auth.css': ['auth.css','text/css'], '/app.js': ['app.js', 'text/javascript'], '/replay.js': ['replay.js','text/javascript'], '/style.css': ['style.css', 'text/css'], '/integrations.css': ['integrations.css', 'text/css'], '/demo.css': ['demo.css', 'text/css'] };
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

export function createApp(store, { ingestionKey, workerEnabled = true,replayOptions = {},authRequired = true,authOptions = {} } = {}) {
  const auth = createAuth(store,authOptions);
  const replayRunner = createReplayRunner(replayOptions);
  const activeReplays = new Set();
  const clients = new Map();
  let busy = false;
  const publish = async update => {
    for (const [res,tokenHash] of clients) {
      try {
        if (authRequired && !await auth.liveSession(tokenHash)) { clients.delete(res); res.end(); }
        else res.write(update ? 'data: update\n\n' : ': heartbeat\n\n');
      } catch { clients.delete(res); res.end(); }
    }
  };
  const notify = () => { void publish(true); };
  const heartbeat = setInterval(() => { void publish(false); }, 15000);
  heartbeat.unref();
  const worker = workerEnabled ? startWorker(store, { onUpdate: notify }) : null;
  // A separately deployed worker has no in-process callback. Refresh subscribed dashboards.
  const externalUpdates = !workerEnabled ? setInterval(notify, 2000) : null;
  externalUpdates?.unref();
  const server = createServer(async (req, res) => {
    securityHeaders(res,{ secure: authOptions.secureCookies || authOptions.publicOrigin?.startsWith('https:') });
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      // Local dashboard mutation endpoints must not be callable cross-origin.
      if (req.method === 'POST' && ((req.headers.origin && req.headers.origin !== auth.requestOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site')) return json(403, { error: 'Cross-origin mutation rejected' });
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
      const session = authRequired ? await auth.session(req) : null;
      if (req.method === 'GET' && url.pathname === '/api/auth/status') return json(200,{
        authenticated: Boolean(session),setupRequired: !await store.ownerCount(),user: session?.user || null,csrfToken: session?.csrfToken || null
      });
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const input = await readJSON(req,2048);
        const loggedIn = await auth.login(input,req.socket.remoteAddress || 'unknown');
        res.setHeader('Set-Cookie',loggedIn.cookie);
        return json(200,{ user: loggedIn.user,csrfToken: loggedIn.csrfToken });
      }
      const publicAsset = req.method === 'GET' && files[url.pathname] && url.pathname !== '/';
      if (authRequired && !session && !publicAsset) {
        if (req.method === 'GET' && url.pathname === '/') { res.writeHead(303,{ Location: '/login','Cache-Control': 'no-store' }); return res.end(); }
        return json(401,{ error: 'Sign-in required' });
      }
      if (authRequired && req.method === 'POST' && !auth.checkCSRF(req,session)) return json(403,{ error: 'Invalid CSRF token' });
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        res.setHeader('Set-Cookie',await auth.logout(session)); await publish(false);
        return json(200,{ ok: true });
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`,'Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
        return res.end(await readFile(join(root, 'public', file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('data: connected\n\n'); clients.set(res,session?.tokenHash || null); req.on('close', () => clients.delete(res)); return;
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
          try {
            let task;
            if (incident.service === 'checkout-api') task = replayIncident(store,match[1]);
            else {
              const input = await readJSON(req,1024);
              if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'revision')) return json(400,{ error: 'Provide only a baseline or candidate revision' });
              task = replaySampleIncident(store,incident,input.revision ?? 'baseline',replayRunner);
            }
            activeReplays.add(task);
            try { const result = await task; notify(); return json(200,result); }
            finally { activeReplays.delete(task); }
          } finally { busy = false; }
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
      if (status === 429) res.setHeader('Retry-After',String(error.retryAfter || 2));
      if (!res.headersSent) json(status, { error: error instanceof SyntaxError ? 'Invalid JSON' : status === 500 ? 'Internal server error' : error.message });
      else res.end();
    }
  });
  configureHttp(server);
  server.stopWorker = async () => { for (const [res] of clients) res.end(); clients.clear(); await worker?.stop(); await replayRunner.close(); await Promise.allSettled([...activeReplays]); };
  server.on('close', () => { clearInterval(heartbeat); clearInterval(externalUpdates); void worker?.stop(); for (const [res] of clients) res.end(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const publicOrigin = deploymentOrigin();
  const store = await openStore();
  const server = createApp(store, { ingestionKey: localIngestionKey(), workerEnabled: process.env.INCIDENTLAB_WORKER_MODE !== 'external',
    authOptions: { publicOrigin,secureCookies: process.env.INCIDENTLAB_COOKIE_SECURE === '1' || publicOrigin?.startsWith('https:') } });
  if (process.env.INCIDENTLAB_REQUEST_LOG === '1') configureHttp(server,{ logRequests: true });
  const port = Number(process.env.PORT || 4317);
  const host = process.env.INCIDENTLAB_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`IncidentLab ready at http://${host}:${port} (${store.backend})`));
  server.on('error', async error => { console.error(error.message); await server.stopWorker(); await store.close(); process.exitCode = 1; });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await shutdown(server,() => store.close()); if (process.connected) process.disconnect(); } catch { console.error('Shutdown failed'); process.exitCode = 1; }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.on('message', message => { if (message === 'shutdown') void stop(); });
}
