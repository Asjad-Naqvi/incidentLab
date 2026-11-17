import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { processNextJob } from '../lib/worker.mjs';
import { shutdown } from '../lib/http-security.mjs';

// Reproducible local measurements, never pointed at a public deployment or owner DB.
const store = createStore();
const key = randomBytes(32).toString('hex');
const server = createApp(store, { ingestionKey: key, workerEnabled: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const durations = []; const batches = 20; const batchSize = 25;
  const started = performance.now();
  for (let i = 0; i < batches; i++) {
    const events = Array.from({ length: batchSize }, () => ({ id: randomUUID(), service: 'benchmark', method: 'POST', path: '/orders', status: 500, durationMs: 10, errorType: 'BenchmarkError' }));
    const before = performance.now();
    const response = await fetch(base+'/api/v1/events', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) });
    const result = await response.json();
    if (response.status !== 202 || result.accepted !== batchSize) throw new Error('Unexpected ingestion response');
    durations.push(performance.now() - before);
  }
  const acceptanceMs = performance.now() - started;
  const queuedBeforeRecovery = store.queueStats().queued;
  const drainStarted = performance.now();
  while (await processNextJob(store)) { /* Resume the deliberately paused worker. */ }
  const drainMs = performance.now() - drainStarted;
  const metrics = store.metrics();
  if (metrics.total !== batches * batchSize || store.queueStats().queued !== 0) throw new Error('Recovery lost events');
  durations.sort((a,b)=>a-b);
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    scope: 'Local HTTP collector + in-memory SQLite, serial batches, paused worker then same-process drain. Not PostgreSQL, public-host capacity, or crash-recovery performance.',
    events: metrics.total, batchSize, concurrentRequests: 1, acceptanceMs: Math.round(acceptanceMs),
    acceptedEventsPerSecond: Math.round(metrics.total / (acceptanceMs / 1000)),
    p95BatchAcceptanceMs: Math.round(durations[Math.ceil(durations.length * .95) - 1]),
    queuedBeforeRecovery, drainedEvents: metrics.total, drainMs: Math.round(drainMs), queueAfterRecovery: store.queueStats() }, null, 2));
} finally { await shutdown(server, () => store.close()); }
