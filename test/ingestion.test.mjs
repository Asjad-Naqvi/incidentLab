import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { processNextJob } from '../lib/worker.mjs';
import { normalizeEvent } from '../sdk/telemetry.mjs';

const key = 'test-only-credential-32-characters';
const event = (extra = {}) => ({ id: randomUUID(), service: 'orders', method: 'POST', path: '/orders/:id', status: 500,
  durationMs: 23.5, errorType: 'DatabaseTimeout', ...extra });
async function app(t, options = {}) {
  const store = createStore();
  const server = createApp(store, { authRequired: false, ingestionKey: key, workerEnabled: false, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (body, authorization = `Bearer ${key}`) => fetch(url + '/api/v1/events', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { store, server, url, send };
}

test('ingestion authenticates before parsing, validates entire batches and reserves fixture identity', async t => {
  const { store, send } = await app(t);
  assert.equal((await send({ events: [event()] }, 'Bearer wrong')).status, 401);
  assert.equal((await send({ events: [] })).status, 400);
  assert.equal((await send({ events: Array.from({ length: 26 }, () => event()) })).status, 400);
  assert.equal((await send({ events: [event(), event({ status: '500' })] })).status, 400);
  assert.equal((await send({ events: [event({ service: 'checkout-api' })] })).status, 400);
  assert.equal((await send({ events: [event({ path: '/orders?token=secret' })] })).status, 400);
  assert.equal((await send({ events: [event({ durationMs: -1 })] })).status, 400);
  assert.equal((await send({ events: [event({ errorType: 'contains a private message' })] })).status, 400);
  assert.equal((await send({ padding: 'x'.repeat(66000) })).status, 413);
  assert.equal(store.queueStats().queued, 0);
});

test('accepted telemetry is durable before processing, redacted and idempotent across retries', async t => {
  const { store, send, url } = await app(t);
  const input = event({ payload: { password: 'do-not-store', nested: { authorization: 'Bearer hidden', email: 'person@example.com', safe: 'visible' } } });
  const first = await send({ events: [input] });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: 1, duplicates: 0 });
  assert.equal(store.metrics().total, 0, 'request only enqueues work');
  assert.equal(store.queueStats().queued, 1);
  const storedJob = store.db.prepare('SELECT event FROM ingestion_jobs').get().event;
  assert.ok(!storedJob.includes('do-not-store'));
  assert.ok(!storedJob.includes('person@example.com'));
  assert.deepEqual(await (await send({ events: [input] })).json(), { accepted: 0, duplicates: 1 });
  assert.equal((await send({ events: [event(), { ...input, status: 503 }] })).status, 409);
  assert.equal(store.queueStats().queued, 1, 'conflicting batch rolls back its other events');
  assert.equal(await processNextJob(store), true);
  assert.equal(await processNextJob(store), false);
  assert.equal(store.metrics().total, 1);
  assert.equal(store.queueStats().complete, 1);
  const incident = store.incidents()[0];
  assert.equal(incident.service, 'orders');
  assert.equal(incident.title, 'DatabaseTimeout');
  assert.equal(store.incident(incident.id).events[0].payload.nested.safe, 'visible');
  assert.equal((await send({ events: [input] })).status, 202);
  assert.equal(await processNextJob(store), false);
  assert.equal((await fetch(`${url}/api/incidents/${incident.id}/replay`, { method: 'POST' })).status, 409);
});

test('worker retries with backoff, dead-letters repeated failures and fences expired leases', async t => {
  const { store } = await app(t);
  const input = normalizeEvent(event());
  store.enqueueBatch([input], 1000);
  const fail = async () => { throw new Error('secret exception must not be stored'); };
  assert.equal(await processNextJob(store, { now: 1000, beforeCommit: fail, maxAttempts: 2 }), true);
  assert.equal(store.queueStats().queued, 1);
  assert.equal(await processNextJob(store, { now: 1999 }), false);
  assert.equal(await processNextJob(store, { now: 2000, beforeCommit: fail, maxAttempts: 2 }), true);
  assert.equal(store.queueStats().dead, 1);
  assert.equal(store.metrics().total, 0);
  assert.equal(store.db.prepare('SELECT last_error FROM ingestion_jobs WHERE id=?').get(input.id).last_error, 'Event processing failed');

  store.enqueueBatch([normalizeEvent(event())], 5000);
  const abandoned = store.claimJob(5000);
  assert.equal(store.claimJob(34999), null);
  const recovered = store.claimJob(35000);
  assert.equal(recovered.id, abandoned.id);
  assert.equal(store.completeJob(abandoned), false, 'late worker cannot commit after losing its lease');
  assert.equal(store.completeJob(recovered), true);
  assert.equal(store.metrics().total, 1);
});

test('same error and route in different services create separate incidents', async t => {
  const { store } = await app(t);
  store.enqueueBatch([normalizeEvent(event({ service: 'orders' })), normalizeEvent(event({ service: 'billing' }))]);
  await processNextJob(store); await processNextJob(store);
  assert.equal(store.incidents().length, 2);
  assert.equal(store.services().length, 2);
});

test('background worker processes authenticated HTTP ingestion automatically', async t => {
  const { store, send } = await app(t, { workerEnabled: true });
  assert.equal((await send({ events: [event()] })).status, 202);
  const deadline = Date.now() + 4000;
  while (store.metrics().total === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(store.metrics().total, 1);
  assert.equal(store.queueStats().complete, 1);
});
