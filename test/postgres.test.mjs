import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { postgresPool, createPostgresStore } from '../lib/postgres-store.mjs';
import { migratePostgres, migrationDirectory } from '../lib/postgres-migrations.mjs';
import { normalizeEvent } from '../sdk/telemetry.mjs';
import { processNextJob } from '../lib/worker.mjs';
import { createApp } from '../server.mjs';
import { projectRoot } from '../lib/config.mjs';
import { createServer as createNetServer } from 'node:net';
import { createReplayRunner,replaySampleIncident } from '../lib/isolated-replay.mjs';
import { hashPassword,createAuth } from '../lib/auth.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
const event = (extra = {}) => normalizeEvent({ id: randomUUID(), service: 'orders', method: 'POST',
  path: '/orders/:id', status: 500, durationMs: 22, errorType: 'Timeout', ...extra });

test('PostgreSQL storage contract and independent worker', { skip: !connectionString }, async t => {
  // Each test run gets a unique schema; an existing test database is never truncated or dropped.
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgresPool(connectionString);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = `-c search_path=${schema}`;
  const pool = postgresPool(connectionString, { options });
  const store = createPostgresStore(pool);
  t.after(async () => { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const reset = () => pool.query('TRUNCATE auth_sessions,auth_users,auth_limits,incident_analyses,replays,events,incidents,ingestion_jobs');
  const migrationFiles = ['001_core.sql','002_ingestion_queue.sql','003_incident_analysis.sql','004_owner_auth.sql'];

  await t.test('versioned migrations serialize concurrent runners and detect changed history', async () => {
    const applied = await Promise.all([migratePostgres(pool), migratePostgres(pool)]);
    assert.equal(applied.flat().length, 4);
    assert.deepEqual(await migratePostgres(pool), []);
    const directory = await mkdtemp(join(tmpdir(), 'incidentlab-migrations-'));
    try {
      for (const name of migrationFiles) await writeFile(join(directory, name), await readFile(join(migrationDirectory, name)));
      await writeFile(join(directory, '001_core.sql'), '-- tampered history');
      await assert.rejects(migratePostgres(pool, directory), /history mismatch/);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n, 4);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  await t.test('failed migration rolls back all pending DDL and migration records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'incidentlab-migration-failure-'));
    try {
      for (const name of migrationFiles) await writeFile(join(directory, name), await readFile(join(migrationDirectory, name)));
      await writeFile(join(directory, '005_bad.sql'), 'CREATE TABLE should_rollback (id INT); SELECT nonexistent_column;');
      await assert.rejects(migratePostgres(pool, directory));
      assert.equal((await pool.query("SELECT to_regclass('should_rollback') AS name")).rows[0].name, null);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n, 4);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  await t.test('durable batches are idempotent, conflict atomically and group by service', async () => {
    await reset();
    const first = event({ payload: { nested: { safe: 1, token: 'hidden' } } });
    assert.deepEqual(await store.enqueueBatch([first]), { accepted: 1, duplicates: 0 });
    assert.deepEqual(await store.enqueueBatch([first]), { accepted: 0, duplicates: 1 });
    await assert.rejects(store.enqueueBatch([event(), { ...first, status: 503 }]), { status: 409 });
    assert.equal((await store.queueStats()).queued, 1);
    await store.enqueueBatch([event(), event({ service: 'billing' })]);
    while (await processNextJob(store)) { /* process queue */ }
    assert.equal((await store.metrics()).total, 3);
    assert.equal((await store.metrics()).p95, 22);
    assert.equal((await store.incidents()).length, 2);
    assert.equal((await store.services()).length, 2);
    const incident = (await store.incidents()).find(i => i.service === 'orders');
    const detail = await store.incident(incident.id);
    assert.equal(detail.events.length, 2);
    assert.equal(detail.events.find(e => e.id === first.id).payload.nested.token, '[redacted]');
    assert.equal((await store.timeline()).reduce((n, b) => n + b.total, 0), 3);
  });

  await t.test('two workers claim disjoint jobs and complete same-fingerprint events without duplication', async () => {
    await reset();
    await store.enqueueBatch(Array.from({ length: 20 }, () => event()));
    const other = createPostgresStore(postgresPool(connectionString, { options }));
    try {
      const claimed = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? other : store).claimJob()));
      assert.equal(new Set(claimed.map(j => j.id)).size, 20);
      await Promise.all(claimed.map((job, i) => (i % 2 ? other : store).completeJob(job)));
      assert.equal((await store.metrics()).total, 20);
      assert.equal((await store.incidents())[0].occurrences, 20);
      assert.equal((await store.queueStats()).complete, 20);
    } finally { await other.close(); }
  });

  await t.test('a locked queue row does not block another worker (SKIP LOCKED)', async () => {
    await reset();
    await store.enqueueBatch([event(), event()], 1000);
    const locked = await pool.connect();
    try {
      await locked.query('BEGIN');
      const held = (await locked.query('SELECT id FROM ingestion_jobs ORDER BY created_at,id LIMIT 1 FOR UPDATE')).rows[0];
      const claimed = await store.claimJob(1000);
      assert.notEqual(claimed.id, held.id);
    } finally { await locked.query('ROLLBACK'); locked.release(); }
  });

  await t.test('retry backoff, dead letters and stale lease fencing work across connections', async () => {
    await reset();
    await store.enqueueBatch([event()], 1000);
    const abandoned = await store.claimJob(1000);
    assert.equal(await store.claimJob(30999), null);
    const recovered = await store.claimJob(31000);
    assert.equal(recovered.id, abandoned.id);
    assert.equal(await store.completeJob(abandoned), false);
    await store.failJob(recovered, { now: 31000, maxAttempts: 3, reason: 'Event processing failed' });
    assert.equal(await store.claimJob(32999), null);
    const final = await store.claimJob(33000);
    await store.failJob(final, { now: 33000, maxAttempts: 3, reason: 'Event processing failed' });
    assert.equal((await store.queueStats()).dead, 1);
    assert.equal((await store.metrics()).total, 0);
  });

  await t.test('event insertion and acknowledgment roll back together after a database error', async () => {
    await reset();
    await store.enqueueBatch([event()]);
    const job = await store.claimJob();
    await pool.query(`CREATE FUNCTION reject_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='complete' THEN RAISE EXCEPTION 'simulated acknowledgment failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_ack BEFORE UPDATE ON ingestion_jobs FOR EACH ROW EXECUTE FUNCTION reject_ack();`);
    try {
      await assert.rejects(store.completeJob(job), /simulated acknowledgment failure/);
      assert.equal((await store.metrics()).total, 0);
      assert.equal((await store.incidents()).length, 0);
      assert.equal((await store.queueStats()).processing, 1);
    } finally { await pool.query('DROP TRIGGER reject_ack ON ingestion_jobs; DROP FUNCTION reject_ack();'); }
    assert.equal(await store.completeJob(job), true);
  });

  await t.test('HTTP fixture replay and resolution use the asynchronous storage contract', async () => {
    await reset(); await store.setFixed(false);
    const server = createApp(store, { authRequired: false, workerEnabled: false });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const post = path => fetch(base + path, { method: 'POST' });
      assert.equal((await post('/api/demo/traffic')).status, 200);
      const overview = await (await fetch(base + '/api/overview')).json();
      assert.equal(overview.metrics.total, 12);
      assert.equal(overview.ingestion.storage, 'postgres');
      const id = overview.incidents[0].id;
      const broken = await (await post(`/api/incidents/${id}/replay`)).json();
      assert.equal(broken.afterErrors, 4);
      await post('/api/demo/fix');
      const fixed = await (await post(`/api/incidents/${id}/replay`)).json();
      assert.equal(fixed.afterErrors, 0);
      assert.equal((await post(`/api/incidents/${id}/resolve`)).status, 200);
      assert.equal((await store.metrics()).open, 0);
    } finally { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('an independently launched worker drains jobs from a separate pool and exits cleanly', async () => {
    await reset();
    await store.enqueueBatch([event(), event()]);
    const child = spawn(process.execPath, ['worker.mjs'], { cwd: projectRoot, windowsHide: true,
      env: { ...process.env, DATABASE_URL: connectionString, PGOPTIONS: options }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 10000;
      while ((await store.metrics()).total < 2 && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await store.metrics()).total, 2, stderr);
    } finally { child.send('shutdown'); assert.equal((await exit).code, 0); }
    assert.equal((await store.queueStats()).complete, 2);
  });

  await t.test('development launcher starts three roles, ingests HTTP traffic, and shuts down its process tree', async () => {
    await reset();
    await store.createOwner('owner',await hashPassword('test-owner-password-123'));
    const freePort = async () => {
      const server = createNetServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
    };
    const port = await freePort(); const samplePort = await freePort();
    const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: projectRoot, windowsHide: true,
      env: { ...process.env, DATABASE_URL: connectionString, PGOPTIONS: options, PORT: String(port),
        SAMPLE_PORT: String(samplePort), SAMPLE_FIXED: '0', INCIDENTLAB_INGESTION_KEY: 'integration-test-key-32-characters' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr.on('data', data => { diagnostics += data; }); child.stdout.resume();
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    try {
      const deadline = Date.now() + 12000;
      let ready = false;
      while (!ready && Date.now() < deadline && child.exitCode === null) {
        try { ready = (await fetch(`http://127.0.0.1:${samplePort}/healthz`, { signal: AbortSignal.timeout(500) })).ok
          && (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Await startup. */ }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(ready, true, diagnostics);
      for (const fixture of ['valid-session', 'expired-session']) {
        const response = await fetch(`http://127.0.0.1:${samplePort}/checkout`, { method: 'POST', body: JSON.stringify({ fixture }) });
        await response.arrayBuffer();
      }
      while ((await store.metrics()).total < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      const signedIn = await fetch(`http://127.0.0.1:${port}/api/auth/login`,{ method: 'POST',body: JSON.stringify({ username: 'owner',password: 'test-owner-password-123' }) });
      assert.equal(signedIn.status,200);
      const cookie = signedIn.headers.get('set-cookie').split(';')[0];
      const overview = await (await fetch(`http://127.0.0.1:${port}/api/overview`,{ headers: { Cookie: cookie } })).json();
      assert.equal(overview.metrics.total, 2);
      assert.equal(overview.ingestion.workerMode, 'external');
      assert.equal(overview.ingestion.storage, 'postgres');
    } finally {
      if (child.connected) child.send('shutdown', () => {});
      const timeout = setTimeout(() => child.kill('SIGTERM'), 10000); timeout.unref();
      try { assert.equal(await exited, 0, diagnostics); } finally { clearTimeout(timeout); }
    }
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }));
    await assert.rejects(fetch(`http://127.0.0.1:${samplePort}/healthz`, { signal: AbortSignal.timeout(500) }));
  });

  await t.test('isolated replay evidence persists in PostgreSQL without changing live metrics or resolving the incident', async () => {
    await reset();
    const recorded = await store.record(event({ service: 'checkout-sample',path: '/checkout',errorType: 'PaymentSessionExpired',payload: { fixture: 'slow-expired-session' } }));
    const incident = await store.incident(recorded.incidentId);
    const runner = createReplayRunner();
    try {
      const replay = await replaySampleIncident(store,incident,'candidate',runner);
      assert.equal(replay.verificationPassed,true); assert.equal(replay.afterErrors,0);
      const other = createPostgresStore(postgresPool(connectionString,{ options }));
      try {
        const saved = await other.incident(incident.id);
        assert.equal(saved.replays[0].id,replay.id);
        assert.equal(saved.replays[0].isolation,'worker-thread');
        assert.equal(saved.replays[0].results[0].afterStatus,409);
        assert.equal(saved.status,'open'); assert.equal((await other.metrics()).total,1);
      } finally { await other.close(); }
    } finally { await runner.close(); }
  });

  await t.test('owner bootstrap, shared sessions and password recovery are atomic across PostgreSQL collectors', async () => {
    await reset();
    const password = 'postgres-auth-test-passphrase';
    const encoded = await hashPassword(password);
    const other = createPostgresStore(postgresPool(connectionString,{ options }));
    try {
      const created = await Promise.allSettled([store.createOwner('first-owner',encoded),other.createOwner('second-owner',encoded)]);
      assert.equal(created.filter(result => result.status === 'fulfilled').length,1);
      assert.equal(await store.ownerCount(),1);
      const user = created.find(result => result.status === 'fulfilled').value;
      const firstAuth = createAuth(store); const secondAuth = createAuth(other);
      const session = await firstAuth.login({ username: user.username,password },'local');
      const request = { headers: { cookie: session.cookie.split(';')[0] } };
      assert.equal((await secondAuth.session(request)).user.id,user.id);
      await other.replaceOwnerPassword(user.username,await hashPassword('replacement-postgres-passphrase'));
      assert.equal(await firstAuth.session(request),null);
      await assert.rejects(store.createSession(user.id,'stale-login-token',Date.now(),Date.now()+3600000,encoded),{ status: 401 });
    } finally { await other.close(); }
  });

  await t.test('login throttling is shared and session-protected HTTP endpoints work against PostgreSQL', async () => {
    await reset();
    const other = createPostgresStore(postgresPool(connectionString,{ options }));
    try {
      const limits = [{ key: 'shared-test-limit',max: 2 }]; const now = Date.now();
      await Promise.all([store.recordLoginAttempt(limits,now),other.recordLoginAttempt(limits,now)]);
      await assert.rejects(other.recordLoginAttempt(limits,now),{ status: 429 });
      await other.recordLoginAttempt(limits,now+16*60000);
    } finally { await other.close(); }
    await store.createOwner('owner',await hashPassword('postgres-http-test-passphrase'));
    const server = createApp(store);
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(base+'/api/overview')).status,401);
      const response = await fetch(base+'/api/auth/login',{ method: 'POST',body: JSON.stringify({ username: 'owner',password: 'postgres-http-test-passphrase' }) });
      assert.equal(response.status,200);
      const cookie = response.headers.get('set-cookie').split(';')[0]; const { csrfToken } = await response.json();
      const headers = { Cookie: cookie,'X-CSRF-Token': csrfToken };
      assert.equal((await fetch(base+'/api/demo/traffic',{ method: 'POST',headers })).status,200);
      assert.equal((await (await fetch(base+'/api/overview',{ headers })).json()).metrics.total,12);
      assert.equal((await fetch(base+'/api/auth/logout',{ method: 'POST',headers })).status,200);
      assert.equal((await fetch(base+'/api/overview',{ headers })).status,401);
    } finally { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});
