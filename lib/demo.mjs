import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createStore } from './store.mjs';
import { createApp } from '../server.mjs';
import { securityHeaders, configureHttp } from './http-security.mjs';

const assets = new Map([['/demo.js', ['demo.js', 'text/javascript']], ['/auth.css', ['auth.css', 'text/css']], ['/demo.css', ['demo.css', 'text/css']]]);
const allowed = (method, path) => method === 'GET'
  ? ['/', '/app.js', '/replay.js', '/style.css', '/integrations.css', '/demo.css', '/api/overview', '/api/stream'].includes(path) || /^\/api\/incidents\/[a-z0-9-]+$/.test(path)
  : method === 'POST' && (['/api/demo/traffic', '/api/demo/fix', '/api/demo/break'].includes(path) || /^\/api\/incidents\/[a-z0-9-]+\/(replay|resolve)$/.test(path));
async function emptyBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw Object.assign(new Error('Demo request too large'), { status: 413 });
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw Object.assign(new Error('The public demo accepts sample data only'), { status: 400 });
}
const digest = token => createHash('sha256').update(token).digest('hex');
const equal = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function createDemoServer({ publicOrigin, secureCookies = publicOrigin?.startsWith('https:') || false,
  maxSessions = 24, ttlMs = 20 * 60000, maxEvents = 120, maxReplays = 12,
  maxRequestsPerMinute = 120, maxMutationsPerMinute = 20, maxStartsPerMinute = 20,
  now = Date.now, logRequests = false } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100 || ttlMs < 1000 || ttlMs > 3600000) throw new Error('Invalid demo capacity or session lifetime');
  const sessions = new Map();
  const retiring = new Set();
  const cookieName = secureCookies ? '__Host-incidentlab_demo' : 'incidentlab_demo';
  let starts = { count: 0, until: now() + 60000 };
  let closing = false;
  const cookie = (token, clear = false) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(ttlMs / 1000)}${secureCookies ? '; Secure' : ''}`;
  const retire = entry => {
    sessions.delete(entry.key);
    entry.app.emit('close'); // Closes SSE clients and stops its refresh timers.
    const task = (async () => { await entry.app.stopWorker(); if (entry.inflight) await new Promise(resolve => { entry.drained = resolve; }); entry.store.close(); })();
    retiring.add(task); task.then(() => retiring.delete(task), () => retiring.delete(task));
    return task;
  };
  const sweep = () => { for (const entry of sessions.values()) if (entry.expiresAt <= now()) void retire(entry); };
  const timer = setInterval(sweep, 30000); timer.unref();
  const session = req => {
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(cookieName.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const entry = sessions.get(digest(token));
    if (!entry) return null;
    if (entry.expiresAt <= now()) { void retire(entry); return null; }
    return entry;
  };
  const newSession = () => {
    sweep();
    if (sessions.size >= maxSessions) throw Object.assign(new Error('The demo is busy. Please try again in a few minutes.'), { status: 503 });
    const token = randomBytes(32).toString('hex');
    const store = createStore(); // Dedicated in-memory database. Never opens the owner database.
    const record = store.record.bind(store); const saveReplay = store.saveReplay.bind(store);
    let events = 0; let replays = 0;
    store.record = event => {
      if (events >= maxEvents) throw Object.assign(new Error('Demo request limit reached. End this demo and start a new one.'), { status: 429 });
      const result = record(event); events++; return result;
    };
    store.saveReplay = (id, result) => {
      if (replays >= maxReplays) throw Object.assign(new Error('Demo replay limit reached. End this demo and start a new one.'), { status: 429 });
      const replay = saveReplay(id, result); replays++; return replay;
    };
    const entry = { key: digest(token), store, csrfToken: randomBytes(32).toString('hex'), expiresAt: now() + ttlMs,
      window: { until: now() + 60000, requests: 0, mutations: 0 }, streams: 0, inflight: 0,
      app: createApp(store, { authRequired: false, workerEnabled: false, authOptions: { publicOrigin, secureCookies } }) };
    sessions.set(entry.key, entry);
    return { entry, token };
  };
  const server = createServer(async (req, res) => {
    securityHeaders(res, { secure: secureCookies });
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (closing) return json(503, { error: 'Server is restarting. Please try again shortly.' });
      if (req.method === 'GET' && path === '/healthz') return json(200, { status: 'ok', mode: 'demo' });
      const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
      if (publicOrigin && req.headers.host !== new URL(publicOrigin).host) return json(421, { error: 'Unexpected host' });
      if (req.method === 'POST' && ((req.headers.origin && req.headers.origin !== expectedOrigin) || req.headers['sec-fetch-site'] === 'cross-site')) return json(403, { error: 'Cross-origin mutation rejected' });
      const entry = session(req);
      if (req.method === 'GET' && path === '/api/auth/status') return json(200, { authenticated: Boolean(entry), setupRequired: false, demo: true,
        user: entry ? { username: 'Demo visitor' } : null, csrfToken: entry?.csrfToken, expiresAt: entry?.expiresAt });
      if (req.method === 'POST' && path === '/api/demo/session') {
        if (req.headers['x-demo-request'] !== '1' || req.headers['content-type'] !== 'application/json') return json(403, { error: 'Start the demo from this website' });
        if (entry) return json(200, { ok: true });
        if (starts.until <= now()) starts = { count: 0, until: now() + 60000 };
        if (++starts.count > maxStartsPerMinute) { res.setHeader('Retry-After', '60'); return json(429, { error: 'Too many demo starts. Please try again in a minute.' }); }
        await emptyBody(req);
        const created = newSession(); res.setHeader('Set-Cookie', cookie(created.token)); return json(201, { ok: true });
      }
      if (req.method === 'GET' && (path === '/login' || (path === '/' && !entry))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(await readFile(new URL('../public/demo.html', import.meta.url)));
      }
      if (req.method === 'GET' && assets.has(path)) {
        const [file, mime] = assets.get(path); res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        return res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      if (!entry) return json(401, { error: 'Your demo has ended. Start a fresh demo.' });
      if (req.method === 'POST' && !equal(req.headers['x-csrf-token'], entry.csrfToken)) return json(403, { error: 'Invalid CSRF token' });
      if (req.method === 'POST' && path === '/api/auth/logout') {
        res.setHeader('Set-Cookie', cookie('', true)); await retire(entry); return json(200, { ok: true });
      }
      if (!allowed(req.method, path)) return json(404, { error: 'This feature is unavailable in the public demo' });
      if (entry.window.until <= now()) entry.window = { until: now() + 60000, requests: 0, mutations: 0 };
      if (++entry.window.requests > maxRequestsPerMinute || (req.method === 'POST' && ++entry.window.mutations > maxMutationsPerMinute)) {
        res.setHeader('Retry-After', '60'); return json(429, { error: 'Please slow down and try again in a minute.' });
      }
      if (req.method === 'POST') await emptyBody(req);
      if (path === '/api/stream') {
        if (entry.streams >= 2) return json(429, { error: 'Too many open demo tabs' });
        entry.streams++; res.once('close', () => entry.streams--);
      }
      // Only the routes above can reach this private application. No ingestion, owner setup,
      // password login, arbitrary checkout payloads or external replay adapters are exposed.
      entry.inflight++;
      let finished = false;
      const finish = () => { if (finished) return; finished = true; if (--entry.inflight === 0) entry.drained?.(); };
      res.once('finish', finish); res.once('close', finish);
      entry.app.emit('request', req, res);
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) console.error('Demo request failed');
      if (!res.headersSent) json(status, { error: status === 500 ? 'Demo unavailable. Please try again.' : error.message });
      else res.end();
    }
  });
  configureHttp(server, { logRequests });
  server.stopWorker = async () => {
    closing = true; clearInterval(timer);
    await Promise.allSettled([...sessions.values()].map(retire));
    await Promise.allSettled([...retiring]);
  };
  server.on('close', () => { clearInterval(timer); void server.stopWorker(); });
  return server;
}
