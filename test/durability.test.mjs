import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { normalizeEvent } from '../sdk/telemetry.mjs';
import { processNextJob } from '../lib/worker.mjs';

const input = () => normalizeEvent({ id: randomUUID(), service: 'orders', method: 'GET', path: '/orders', status: 500, durationMs: 10, errorType: 'Timeout' });

test('queued and leased jobs survive restart and stale leases are recovered without duplicate events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'incidentlab-queue-'));
  const file = join(directory, 'queue.sqlite');
  try {
    const first = createStore(file);
    const events = [input(), input()];
    try { first.enqueueBatch(events, 1000); first.claimJob(1000); } finally { first.close(); }
    const second = createStore(file);
    try {
      assert.equal(await processNextJob(second, { now: 1000 }), true, 'unleased work is immediately available after restart');
      assert.equal(await processNextJob(second, { now: 30999 }), false);
      assert.equal(await processNextJob(second, { now: 31000 }), true, 'abandoned lease becomes available after 30 seconds');
      assert.equal(second.metrics().total, 2);
      assert.equal(second.queueStats().complete, 2);
      assert.deepEqual(second.enqueueBatch(events), { accepted: 0, duplicates: 2 });
      assert.equal(second.incidents()[0].occurrences, 2);
    } finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('event write and queue acknowledgment are atomic when a database operation fails', () => {
  const store = createStore();
  try {
    store.enqueueBatch([input()]);
    const job = store.claimJob();
    store.db.exec("CREATE TRIGGER reject_ack BEFORE UPDATE ON ingestion_jobs WHEN NEW.state='complete' BEGIN SELECT RAISE(ABORT, 'simulated storage error'); END;");
    assert.throws(() => store.completeJob(job), /simulated storage error/);
    assert.equal(store.metrics().total, 0);
    assert.equal(store.incidents().length, 0);
    assert.equal(store.queueStats().processing, 1);
    store.db.exec('DROP TRIGGER reject_ack');
    assert.equal(store.completeJob(job), true);
    assert.equal(store.metrics().total, 1);
  } finally { store.close(); }
});

test('original prototype database migrates without losing evidence or splitting existing groups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'incidentlab-migrate-'));
  const file = join(directory, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, incident_id TEXT, created_at TEXT NOT NULL,
        method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, duration_ms REAL NOT NULL,
        error TEXT, payload TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE incidents (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
        service TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO incidents VALUES ('legacy', 'POST:/demo/checkout:expiry', 'expiry', 'checkout-api', 'critical', 'open', '2026-01-01', '2026-01-01');
        INSERT INTO events VALUES ('legacy-event', 'legacy', '2026-01-01', 'POST', '/demo/checkout', 500, 20, 'expiry', '{}', 'live');`);
    } finally { legacy.close(); }
    const upgraded = createStore(file);
    try {
      upgraded.record({ method: 'POST', path: '/demo/checkout', status: 500, durationMs: 21, error: 'expiry' });
      assert.equal(upgraded.incidents().length, 1);
      assert.equal(upgraded.incidents()[0].occurrences, 2);
      assert.equal(upgraded.metrics().total, 2);
      assert.equal(upgraded.incident('legacy').events[0].service, 'checkout-api');
    } finally { upgraded.close(); }
    const reopened = createStore(file);
    try { assert.equal(reopened.incidents()[0].fingerprint, 'checkout-api:POST:/demo/checkout:expiry'); }
    finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
