import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function postgresPool(connectionString, extra = {}) {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000, ...extra });
  pool.on('error', () => console.error('PostgreSQL idle connection failed'));
  return pool;
}

export function createPostgresStore(pool) {
  const query = (sql, values) => pool.query(sql, values);
  const transaction = async fn => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  async function writeEvent(client, { id = randomUUID(), method, path, status, durationMs, error = null,
    payload = {}, source = 'live', service = 'checkout-api' }) {
    // Serialize only identical event IDs; unrelated events and workers can proceed concurrently.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
    if ((await client.query('SELECT id FROM events WHERE id=$1', [id])).rowCount) return { id, duplicate: true };
    const now = new Date().toISOString();
    let incidentId = null;
    if (status >= 500) {
      const { rows } = await client.query(`INSERT INTO incidents (id,fingerprint,title,service,severity,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'critical',$5,$5) ON CONFLICT (fingerprint)
        DO UPDATE SET status='open',updated_at=EXCLUDED.updated_at RETURNING id`,
      [randomUUID(), `${service}:${method}:${path}:${error}`, error || 'Unhandled service error', service, now]);
      incidentId = rows[0].id;
    }
    await client.query(`INSERT INTO events (id,incident_id,created_at,method,path,status,duration_ms,error,payload,source,service)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, incidentId, now, method, path, status, durationMs, error, JSON.stringify(payload), source, service]);
    return { id, incidentId };
  }
  const store = {
    backend: 'postgres', pool,
    async ping() { await query('SELECT 1'); return true; },
    async isFixed() { return (await query("SELECT value FROM settings WHERE key='paymentFixed'")).rows[0].value === 'true'; },
    async setFixed(value) { await query("UPDATE settings SET value=$1 WHERE key='paymentFixed'", [String(value)]); },
    record(event) { return transaction(client => writeEvent(client, event)); },
    enqueueBatch(events, now = Date.now()) {
      return transaction(async client => {
        // Serialize producers to enforce the queue cap and whole-batch conflict semantics.
        await client.query('SELECT pg_advisory_xact_lock(4317002)');
        const pending = Number((await client.query("SELECT COUNT(*) AS n FROM ingestion_jobs WHERE state IN ('queued','processing')")).rows[0].n);
        let accepted = 0; let duplicates = 0;
        for (const event of events) {
          const existing = (await client.query('SELECT event FROM ingestion_jobs WHERE id=$1', [event.id])).rows[0];
          if (existing) {
            if (!isDeepStrictEqual(existing.event, event)) throw Object.assign(new Error('Event ID already used for different content'), { status: 409 });
            duplicates++; continue;
          }
          if (pending + accepted >= 10000) throw Object.assign(new Error('Ingestion queue is full; retry later'), { status: 429 });
          await client.query('INSERT INTO ingestion_jobs (id,event,available_at,created_at) VALUES ($1,$2,$3,$4)', [event.id, JSON.stringify(event), now, new Date(now).toISOString()]);
          accepted++;
        }
        return { accepted, duplicates };
      });
    },
    async claimJob(now = Date.now()) {
      const { rows } = await query(`WITH next AS (
        SELECT id FROM ingestion_jobs WHERE (state='queued' AND available_at <= $1)
          OR (state='processing' AND lease_until <= $1)
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE ingestion_jobs j SET state='processing',attempts=j.attempts+1,lease_until=$2
        FROM next WHERE j.id=next.id RETURNING j.*`, [now, now + 30000]);
      const row = rows[0];
      return row ? { id: row.id, event: row.event, attempts: row.attempts, lease: Number(row.lease_until) } : null;
    },
    completeJob(job) {
      return transaction(async client => {
        const current = await client.query("SELECT id FROM ingestion_jobs WHERE id=$1 AND state='processing' AND attempts=$2 AND lease_until=$3 FOR UPDATE", [job.id, job.attempts, job.lease]);
        if (!current.rowCount) return false;
        await writeEvent(client, job.event);
        await client.query("UPDATE ingestion_jobs SET state='complete',lease_until=NULL,last_error=NULL WHERE id=$1", [job.id]);
        return true;
      });
    },
    async failJob(job, { now, maxAttempts, reason }) {
      await query(`UPDATE ingestion_jobs SET state=$1, available_at=$2,lease_until=NULL,last_error=$3
        WHERE id=$4 AND state='processing' AND attempts=$5 AND lease_until=$6`,
      [job.attempts >= maxAttempts ? 'dead' : 'queued', now + Math.min(60000, 1000 * 2 ** (job.attempts - 1)), reason, job.id, job.attempts, job.lease]);
    },
    async queueStats() {
      const counts = { queued: 0, processing: 0, complete: 0, dead: 0 };
      for (const row of (await query('SELECT state,COUNT(*) AS n FROM ingestion_jobs GROUP BY state')).rows) counts[row.state] = Number(row.n);
      return counts;
    },
    async services() {
      return (await query(`SELECT service,COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE status>=500)::int AS errors,MAX(created_at) AS last_seen
        FROM events WHERE source='live' GROUP BY service ORDER BY last_seen DESC`)).rows;
    },
    async incidents() {
      return (await query(`SELECT i.*,COUNT(e.id)::int AS occurrences,
        ROUND(AVG(e.duration_ms)::numeric,1)::float8 AS avg_duration_ms FROM incidents i
        LEFT JOIN events e ON e.incident_id=i.id GROUP BY i.id ORDER BY i.updated_at DESC`)).rows;
    },
    async incident(id) {
      const incident = (await query('SELECT * FROM incidents WHERE id=$1', [id])).rows[0];
      if (!incident) return null;
      const events = (await query('SELECT * FROM events WHERE incident_id=$1 ORDER BY created_at DESC,id', [id])).rows;
      const replays = (await query('SELECT * FROM replays WHERE incident_id=$1 ORDER BY created_at DESC,id', [id])).rows
        .map(r => ({ ...r.result, id: r.id, created_at: r.created_at }));
      return { ...incident, events, replays };
    },
    async saveReplay(id, result) {
      const replay = { id: randomUUID(), created_at: new Date().toISOString(), ...result };
      await query('INSERT INTO replays VALUES ($1,$2,$3,$4)', [replay.id, id, replay.created_at, JSON.stringify(result)]);
      return replay;
    },
    async resolve(id) { await query("UPDATE incidents SET status='resolved',updated_at=$1 WHERE id=$2", [new Date().toISOString(), id]); },
    async metrics() {
      const { rows } = await query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status>=500)::int AS failed,
        COALESCE(percentile_disc(.95) WITHIN GROUP (ORDER BY duration_ms),0) AS p95,
        (SELECT COUNT(*)::int FROM incidents WHERE status='open') AS open FROM events WHERE source='live'`);
      const row = rows[0]; return { ...row, errorRate: row.total ? row.failed / row.total * 100 : 0 };
    },
    async timeline() {
      const now = Date.now(); const start = now - 3600000;
      const { rows } = await query(`SELECT floor((extract(epoch FROM created_at::timestamptz)*1000-$1)/120000)::int AS bucket,
        COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status>=500)::int AS errors FROM events
        WHERE source='live' AND created_at >= $2 AND created_at < $3 GROUP BY bucket`, [start, new Date(start).toISOString(), new Date(now).toISOString()]);
      return Array.from({ length: 30 }, (_, index) => ({ time: new Date(start + index * 120000).toISOString(),
        total: rows.find(r => r.bucket === index)?.total || 0, errors: rows.find(r => r.bucket === index)?.errors || 0 }));
    },
    async close() { await pool.end(); }
  };
  return store;
}
