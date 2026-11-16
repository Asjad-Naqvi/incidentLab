import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

test('checkout failure → grouped incident → failed replay → fix → successful replay → resolution', async t => {
  const store = createStore();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path => (await fetch(base + path)).json();
  const post = path => fetch(base + path, { method: 'POST' });

  assert.equal((await get('/api/overview')).metrics.total, 0);
  assert.equal((await post('/api/demo/traffic')).status, 200);
  assert.equal((await post('/api/demo/traffic')).status, 200);
  const overview = await get('/api/overview');
  assert.equal(overview.metrics.total, 24);
  assert.equal(overview.metrics.failed, 8);
  assert.equal(overview.incidents.length, 1, 'same fingerprint groups failures');
  assert.equal(overview.incidents[0].occurrences, 8);
  assert.equal(overview.metrics.open, 1);
  const id = overview.incidents[0].id;
  assert.equal((await post(`/api/incidents/${id}/resolve`)).status, 409);
  const broken = await (await post(`/api/incidents/${id}/replay`)).json();
  assert.equal(broken.afterErrors, 8);
  assert.equal(broken.afterErrorRate, 100);
  assert.equal((await get('/api/overview')).metrics.total, 24, 'replay must not pollute live metrics');
  await post('/api/demo/fix');
  assert.equal((await post(`/api/incidents/${id}/resolve`)).status, 409, 'old failed replay does not verify a fix');
  const fixed = await (await post(`/api/incidents/${id}/replay`)).json();
  assert.equal(fixed.beforeErrors, 8);
  assert.equal(fixed.afterErrors, 0);
  assert.ok(fixed.results.every(r => r.afterStatus === 409), 'handled expiry is not a successful purchase');
  assert.equal((await post(`/api/incidents/${id}/resolve`)).status, 200);
  assert.equal((await get('/api/overview')).metrics.open, 0);
  assert.equal((await get(`/api/incidents/${id}`)).replays.length, 2);
  await post('/api/demo/break');
  await post('/api/demo/traffic');
  assert.equal((await get('/api/overview')).metrics.open, 1, 'recurring failure reopens the incident');
  await post('/api/demo/fix');
  assert.equal((await post(`/api/incidents/${id}/resolve`)).status, 409, 'recurrent failures invalidate old replay evidence');
});

test('HTTP boundaries: local assets, input validation, origin checks and payload allowlist', async t => {
  const store = createStore();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /IncidentLab/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/api/demo/fix', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/demo/checkout', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(base + '/demo/checkout', { method: 'POST', body: JSON.stringify({ fixture: 'unknown' }) })).status, 400);
  assert.equal((await fetch(base + '/demo/checkout', { method: 'POST', body: 'a'.repeat(5000) })).status, 413);
  const response = await fetch(base + '/demo/checkout', { method: 'POST', body: JSON.stringify({ fixture: 'expired-session', password: 'never-store-me' }) });
  assert.equal(response.status, 500);
  const incident = store.incidents()[0];
  assert.deepEqual(store.incident(incident.id).events[0].payload, { fixture: 'expired-session', amount: 49 });
  assert.equal((await fetch(base + '/api/incidents/missing')).status, 404);
});

test('SQLite preserves captured evidence and fixture state across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'incidentlab-test-'));
  const file = join(directory, 'test.sqlite');
  try {
    const first = createStore(file);
    try {
      first.record({ method: 'POST', path: '/demo/checkout', status: 500, durationMs: 24, error: 'expiry', payload: { fixture: 'expired-session' } });
      first.setFixed(true);
    } finally { first.close(); }
    const second = createStore(file);
    try { assert.equal(second.metrics().total, 1); assert.equal(second.incidents().length, 1); assert.equal(second.isFixed(), true); }
    finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
