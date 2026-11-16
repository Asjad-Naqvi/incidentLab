import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStore } from '../lib/store.mjs';
import { createReplayRunner,replaySampleIncident } from '../lib/isolated-replay.mjs';
import { selectReplayInputs,summarizeTimings } from '../lib/replay-contract.mjs';
import { createApp } from '../server.mjs';
import { createSampleService } from '../sample/server.mjs';
import { createClient } from '../sdk/index.mjs';
import { processNextJob } from '../lib/worker.mjs';
import { externalDetail,replaySummary } from '../public/replay.js';

function capture(store,extra = {}) {
  const event = store.record({ method: 'POST',path: '/checkout',status: 500,durationMs: 110,
    service: 'checkout-sample',error: 'PaymentSessionExpired',payload: { fixture: 'slow-expired-session',password: 'never-forward' },...extra });
  return store.incident(event.incidentId);
}
class StalledWorker extends Worker {
  constructor() { super('setInterval(() => {},1000)',{ eval: true,env: {} }); }
}
class FailedWorker extends Worker {
  constructor() { super('throw new Error("private worker detail")',{ eval: true,env: {} }); }
}

test('adapter selection rejects arbitrary services, routes and unrecognized payloads and caps request snapshots', () => {
  const store = createStore();
  try {
    const valid = capture(store);
    const selected = selectReplayInputs(valid);
    assert.equal(selected[0].fixture,'slow-expired-session');
    assert.ok(!JSON.stringify(selected).includes('never-forward'));
    assert.throws(() => selectReplayInputs({ ...valid,service: 'arbitrary' }),{ status: 409 });
    assert.throws(() => selectReplayInputs({ ...valid,title: 'OtherError' }),{ status: 409 });
    for (const change of [{ path: 'https://example.com' },{ method: 'DELETE' },{ payload: { fixture: 'untrusted-code' } }]) {
      assert.throws(() => selectReplayInputs({ ...valid,events: [{ ...valid.events[0],...change }] }),{ status: 409 });
    }
    for (let i=0;i<25;i++) capture(store);
    assert.equal(selectReplayInputs(store.incident(valid.id)).length,20);
    assert.deepEqual(summarizeTimings([5,1,4,2,3]),{ meanMs: 3,p50Ms: 3,p95Ms: 5 });
  } finally { store.close(); }
});

test('fresh baseline reproduces captured failures; candidate measures paired timings and stays out of live metrics', async () => {
  const store = createStore(); const runner = createReplayRunner();
  try {
    const item = capture(store); capture(store);
    const current = store.incident(item.id);
    const baseline = await replaySampleIncident(store,current,'baseline',runner);
    assert.equal(baseline.state,'completed'); assert.equal(baseline.afterErrors,2);
    assert.equal(baseline.verificationPassed,false);
    const candidate = await replaySampleIncident(store,current,'candidate',runner);
    assert.equal(candidate.reproduced,2); assert.equal(candidate.afterErrors,0);
    assert.ok(candidate.results.every(r => r.beforeStatus === 500 && r.afterStatus === 409));
    assert.equal(candidate.verificationPassed,true);
    assert.equal(candidate.liveServiceChanged,false);
    assert.equal(candidate.isolation,'worker-thread');
    assert.match(candidate.implementationHash,/^[0-9a-f]{64}$/);
    assert.ok(candidate.beforeLatency.p95Ms >= 90,'slow fixture delay was measured');
    assert.ok(candidate.afterLatency.p95Ms >= 0);
    assert.equal(store.metrics().total,2,'replays do not count as live requests');
    assert.equal(store.incident(item.id).status,'open');
    assert.equal(store.incident(item.id).replays.length,2);
    assert.match(externalDetail(store.incident(item.id)),/Candidate passed in adapter/);
    assert.match(replaySummary(candidate),/isolated candidate/);
  } finally { await runner.close(); store.close(); }
});

test('workers receive only sanitized fixtures, an empty environment and explicit memory limits', async () => {
  const store = createStore(); let seen;
  class InspectWorker extends Worker {
    constructor(url,options) { seen = options; super(url,options); }
  }
  const runner = createReplayRunner({ WorkerClass: InspectWorker });
  try {
    const item = capture(store,{ payload: { fixture: 'expired-session',authorization: 'secret-header',url: 'https://invalid.example' } });
    await replaySampleIncident(store,item,'candidate',runner);
    assert.deepEqual(seen.env,{}); assert.deepEqual(seen.execArgv,[]);
    assert.equal(seen.resourceLimits.maxOldGenerationSizeMb,32);
    assert.ok(!JSON.stringify(seen.workerData).includes('secret-header'));
    assert.ok(!JSON.stringify(seen.workerData).includes('https://'));
  } finally { await runner.close(); store.close(); }
});

test('deadlines and worker crashes persist failed evidence instead of a verification result', async () => {
  const store = createStore();
  try {
    const item = capture(store);
    for (const [WorkerClass,timeoutMs,errorCode] of [[StalledWorker,30,'timeout'],[FailedWorker,5000,'worker_failed']]) {
      const runner = createReplayRunner({ WorkerClass,timeoutMs });
      try {
        const failed = await replaySampleIncident(store,item,'candidate',runner);
        assert.equal(failed.state,'failed'); assert.equal(failed.errorCode,errorCode);
        assert.equal(failed.verificationPassed,false); assert.deepEqual(failed.results,[]);
        assert.ok(!JSON.stringify(failed).includes('private worker detail'));
        assert.match(replaySummary(failed),/Replay failed/);
      } finally { await runner.close(); }
    }
    assert.equal(store.incident(item.id).replays.length,2);
  } finally { store.close(); }
});

test('runner shutdown cancels active workers and rejects later runs', async () => {
  const runner = createReplayRunner({ WorkerClass: StalledWorker });
  const pending = runner.run([],'candidate');
  const rejected = assert.rejects(pending,{ code: 'cancelled' });
  await runner.close(); await rejected;
  await assert.rejects(runner.run([],'baseline'),/closed/);
});

test('HTTP replay validates revisions, rejects arbitrary targets and cannot resolve a live external incident', async t => {
  const store = createStore(); const item = capture(store);
  const server = createApp(store);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/incidents/${item.id}/replay`,{ method: 'POST',body: JSON.stringify(body) });
  assert.equal((await post({ revision: 'production' })).status,400);
  assert.equal((await post({ revision: 'candidate',url: 'http://example.com' })).status,400);
  const result = await (await post({ revision: 'candidate' })).json();
  assert.equal(result.verificationPassed,true);
  assert.equal((await fetch(`${base}/api/incidents/${item.id}/resolve`,{ method: 'POST' })).status,409);
  assert.equal(store.incident(item.id).status,'open');
  assert.equal((await fetch(base+'/replay.js')).status,200);
});

test('external sample ingestion → isolated replay preserves live service behavior and metrics', async t => {
  const store = createStore(); const key = 'replay-integration-credential-32chars';
  const collector = createApp(store,{ ingestionKey: key,workerEnabled: false });
  await new Promise(resolve => collector.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${collector.address().port}`;
  const client = createClient({ endpoint: base,apiKey: key,service: 'checkout-sample',payloadKeys: ['fixture'],flushIntervalMs: 0 });
  const sample = createSampleService({ client });
  await new Promise(resolve => sample.listen(0,'127.0.0.1',resolve));
  const sampleBase = `http://127.0.0.1:${sample.address().port}`;
  t.after(async () => {
    sample.closeAllConnections(); await new Promise(resolve => sample.close(resolve));
    await client.close(); await collector.stopWorker(); collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve)); store.close();
  });
  const send = () => fetch(sampleBase+'/checkout',{ method: 'POST',body: JSON.stringify({ fixture: 'slow-expired-session' }) });
  assert.equal((await send()).status,500); await client.flush(); await processNextJob(store);
  const id = store.incidents()[0].id;
  const result = await (await fetch(`${base}/api/incidents/${id}/replay`,{ method: 'POST',body: JSON.stringify({ revision: 'candidate' }) })).json();
  assert.equal(result.state,'completed'); assert.equal(result.verificationPassed,true);
  assert.equal(store.metrics().total,1); assert.equal(store.incident(id).status,'open');
  assert.equal((await send()).status,500,'isolated patch does not change the running sample');
});

test('collector rejects concurrent fixture work and saves cancellation before shutting down its runner', async t => {
  const store = createStore(); const item = capture(store);
  let entered; const started = new Promise(resolve => { entered = resolve; });
  class AnnouncedWorker extends StalledWorker { constructor(...args) { super(...args); entered(); } }
  const server = createApp(store,{ replayOptions: { WorkerClass: AnnouncedWorker } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = fetch(`${base}/api/incidents/${item.id}/replay`,{ method: 'POST',body: '{"revision":"candidate"}' });
  await started;
  assert.equal((await fetch(`${base}/api/demo/traffic`,{ method: 'POST' })).status,409);
  await server.stopWorker();
  const cancelled = await (await pending).json();
  assert.equal(cancelled.state,'failed'); assert.equal(cancelled.errorCode,'cancelled');
  assert.equal(store.incident(item.id).replays[0].errorCode,'cancelled');
});
