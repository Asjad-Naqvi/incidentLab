import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../sdk/index.mjs';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { createSampleService } from '../sample/server.mjs';
import { processNextJob } from '../lib/worker.mjs';

const input = { method: 'POST', path: '/checkout', status: 500, durationMs: 25, errorType: 'PaymentSessionExpired' };
const config = { endpoint: 'http://127.0.0.1:4317', apiKey: 'test-only-key-24-characters', service: 'checkout-sample', flushIntervalMs: 0, retryDelayMs: 0 };

test('SDK retries transient errors with stable IDs, redacts opted-in data and excludes other payload fields', async () => {
  const sent = [];
  const client = createClient({ ...config, payloadKeys: ['fixture', 'nested'], fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return new Response('{}', { status: sent.length < 3 ? 503 : 202 });
  } });
  try {
    assert.equal(client.capture({ ...input, payload: { fixture: 'expired-session', nested: { token: 'secret', safe: 1 }, card: 'private' } }), true);
    assert.deepEqual(await client.flush(), { delivered: 1, pending: 0 });
    assert.equal(sent.length, 3);
    assert.equal(sent[0].events[0].id, sent[2].events[0].id);
    assert.deepEqual(sent[0].events[0].payload, { fixture: 'expired-session', nested: { token: '[redacted]', safe: 1 } });
  } finally { await client.close(); }
});

test('SDK retains outage batches, bounds memory, serializes concurrent flushes and does not retry 401', async () => {
  let requests = 0;
  const client = createClient({ ...config, capacity: 1, fetchImpl: async () => { requests++; return new Response('{}', { status: 401 }); }, onError: () => { throw new Error('callback failure'); } });
  assert.equal(client.capture(input), true);
  assert.equal(client.capture(input), false);
  const first = client.flush();
  assert.equal(client.flush(), first);
  await first;
  assert.equal(requests, 1);
  assert.equal(client.pending, 1);
  await client.close();
  assert.equal(client.capture(input), false);
});

test('SDK refuses remote plaintext telemetry and invalid events without interrupting callers', async () => {
  assert.throws(() => createClient({ ...config, endpoint: 'http://untrusted.example' }), /HTTPS/);
  const client = createClient({ ...config });
  assert.equal(client.capture({ ...input, path: '/checkout?token=secret' }), false);
  assert.equal(client.capture({ ...input, status: 900 }), false);
  assert.equal(client.pending, 0);
  await client.close();
});

test('SDK splits large Unicode payload batches below the collector byte limit', async () => {
  const batches = [];
  const client = createClient({ ...config, payloadKeys: ['details'], fetchImpl: async (_url, options) => {
    batches.push(options.body); return new Response('{}', { status: 202 });
  } });
  try {
    const details = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, '界'.repeat(200)]));
    for (let i = 0; i < 25; i++) assert.equal(client.capture({ ...input, payload: { details } }), true);
    assert.deepEqual(await client.flush(), { delivered: 25, pending: 0 });
    assert.ok(batches.length > 1);
    assert.ok(batches.every(body => Buffer.byteLength(body) <= 60 * 1024));
    assert.equal(batches.reduce((n, body) => n + JSON.parse(body).events.length, 0), 25);
  } finally { await client.close(); }
});

test('separate sample HTTP service delivers measured requests through SDK to the collector', async t => {
  const store = createStore();
  const collector = createApp(store, { ingestionKey: config.apiKey, workerEnabled: false });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const client = createClient({ ...config, endpoint: `http://127.0.0.1:${collector.address().port}`, payloadKeys: ['fixture', 'amount'] });
  const sample = createSampleService({ client });
  await new Promise(resolve => sample.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sample.closeAllConnections(); await new Promise(resolve => sample.close(resolve));
    await client.close(); await collector.stopWorker(); collector.closeAllConnections();
    await new Promise(resolve => collector.close(resolve)); store.close();
  });
  const base = `http://127.0.0.1:${sample.address().port}`;
  for (const fixture of ['valid-session', 'expired-session', 'expired-session']) {
    const response = await fetch(base + '/checkout', { method: 'POST', body: JSON.stringify({ fixture, amount: 49, password: 'do-not-persist' }) });
    assert.equal(response.status, fixture === 'valid-session' ? 200 : 500);
    await response.arrayBuffer();
  }
  await client.flush();
  while (await processNextJob(store)) { /* drain persisted telemetry */ }
  assert.equal(store.metrics().total, 3);
  assert.equal(store.metrics().failed, 2);
  assert.equal(store.incidents().length, 1);
  assert.equal(store.incidents()[0].service, 'checkout-sample');
  assert.equal(store.incidents()[0].occurrences, 2);
  const captured = store.incident(store.incidents()[0].id).events;
  assert.ok(captured.every(e => e.duration_ms >= 0));
  assert.ok(captured.every(e => !Object.hasOwn(e.payload, 'password')));
});
