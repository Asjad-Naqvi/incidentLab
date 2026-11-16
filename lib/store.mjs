import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function createStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('paymentFixed', 'false');
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      service TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, incident_id TEXT REFERENCES incidents(id),
      created_at TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
      status INTEGER NOT NULL, duration_ms REAL NOT NULL, error TEXT,
      payload TEXT NOT NULL, source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replays (
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, created_at TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
      lease_until INTEGER, last_error TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_ready ON ingestion_jobs(state, available_at);
    CREATE INDEX IF NOT EXISTS events_incident ON events(incident_id, created_at);
  `);
  // Additive migration keeps the original prototype's database usable.
  if (!db.prepare('PRAGMA table_info(events)').all().some(c => c.name === 'service')) {
    db.exec("ALTER TABLE events ADD COLUMN service TEXT NOT NULL DEFAULT 'checkout-api'");
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    db.exec("BEGIN IMMEDIATE; UPDATE incidents SET fingerprint=service || ':' || fingerprint; PRAGMA user_version=2; COMMIT;");
  }
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function writeEvent({ id = randomUUID(), method, path, status, durationMs, error = null, payload = {}, source = 'live', service = 'checkout-api' }) {
    if (db.prepare('SELECT id FROM events WHERE id=?').get(id)) return { id, duplicate: true };
    const now = new Date().toISOString();
    let incidentId = null;
    if (status >= 500) {
      const fingerprint = `${service}:${method}:${path}:${error}`;
      const existing = db.prepare('SELECT id FROM incidents WHERE fingerprint=?').get(fingerprint);
      incidentId = existing?.id ?? randomUUID();
      if (existing) db.prepare("UPDATE incidents SET updated_at=?, status='open' WHERE id=?").run(now, incidentId);
      else db.prepare('INSERT INTO incidents (id,fingerprint,title,service,severity,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(incidentId, fingerprint, error || 'Unhandled service error', service, 'critical', now, now);
    }
    db.prepare('INSERT INTO events (id,incident_id,created_at,method,path,status,duration_ms,error,payload,source,service) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, incidentId, now, method, path, status, durationMs, error, JSON.stringify(payload), source, service);
    return { id, incidentId };
  }
  return {
    backend: 'sqlite',
    ping() { db.prepare('SELECT 1').get(); return true; },
    db,
    isFixed: () => db.prepare("SELECT value FROM settings WHERE key='paymentFixed'").get().value === 'true',
    setFixed(value) { db.prepare("UPDATE settings SET value=? WHERE key='paymentFixed'").run(String(value)); },
    record(event) { return transaction(() => writeEvent(event)); },
    enqueueBatch(events, now = Date.now()) {
      return transaction(() => {
        let accepted = 0;
        let duplicates = 0;
        const pending = db.prepare("SELECT COUNT(*) AS n FROM ingestion_jobs WHERE state IN ('queued','processing')").get().n;
        for (const event of events) {
          const serialized = JSON.stringify(event);
          const existing = db.prepare('SELECT event FROM ingestion_jobs WHERE id=?').get(event.id);
          if (existing) {
            if (existing.event !== serialized) throw Object.assign(new Error('Event ID already used for different content'), { status: 409 });
            duplicates++; continue;
          }
          if (pending + accepted >= 10000) throw Object.assign(new Error('Ingestion queue is full; retry later'), { status: 429 });
          db.prepare('INSERT INTO ingestion_jobs (id,event,available_at,created_at) VALUES (?,?,?,?)')
            .run(event.id, serialized, now, new Date(now).toISOString());
          accepted++;
        }
        return { accepted, duplicates };
      });
    },
    claimJob(now = Date.now()) {
      return transaction(() => {
        const row = db.prepare("SELECT * FROM ingestion_jobs WHERE (state='queued' AND available_at<=?) OR (state='processing' AND lease_until<=?) ORDER BY created_at,id LIMIT 1").get(now, now);
        if (!row) return null;
        // A token fences out a worker whose lease expired while another worker recovered the job.
        const lease = now + 30000;
        db.prepare("UPDATE ingestion_jobs SET state='processing', attempts=attempts+1, lease_until=? WHERE id=?").run(lease, row.id);
        return { id: row.id, event: JSON.parse(row.event), attempts: row.attempts + 1, lease };
      });
    },
    completeJob(job) {
      return transaction(() => {
        const current = db.prepare("SELECT id FROM ingestion_jobs WHERE id=? AND state='processing' AND attempts=? AND lease_until=?").get(job.id, job.attempts, job.lease);
        if (!current) return false;
        writeEvent(job.event);
        db.prepare("UPDATE ingestion_jobs SET state='complete', lease_until=NULL, last_error=NULL WHERE id=?").run(job.id);
        return true;
      });
    },
    failJob(job, { now, maxAttempts, reason }) {
      db.prepare("UPDATE ingestion_jobs SET state=?, available_at=?, lease_until=NULL,last_error=? WHERE id=? AND state='processing' AND attempts=? AND lease_until=?")
        .run(job.attempts >= maxAttempts ? 'dead' : 'queued', now + Math.min(60000, 1000 * 2 ** (job.attempts - 1)), reason, job.id, job.attempts, job.lease);
    },
    queueStats() {
      const counts = { queued: 0, processing: 0, complete: 0, dead: 0 };
      for (const row of db.prepare('SELECT state,COUNT(*) AS n FROM ingestion_jobs GROUP BY state').all()) counts[row.state] = row.n;
      return counts;
    },
    services() {
      return db.prepare(`SELECT service, COUNT(*) AS requests,
        SUM(CASE WHEN status>=500 THEN 1 ELSE 0 END) AS errors,
        MAX(created_at) AS last_seen FROM events WHERE source='live' GROUP BY service ORDER BY last_seen DESC`).all();
    },
    incidents() {
      return db.prepare(`SELECT i.*, COUNT(e.id) AS occurrences,
        ROUND(AVG(e.duration_ms), 1) AS avg_duration_ms FROM incidents i
        LEFT JOIN events e ON e.incident_id=i.id GROUP BY i.id ORDER BY i.updated_at DESC`).all();
    },
    incident(id) {
      const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
      if (!incident) return null;
      return { ...incident,
        events: db.prepare('SELECT * FROM events WHERE incident_id=? ORDER BY created_at DESC').all(id)
          .map(e => ({ ...e, payload: JSON.parse(e.payload) })),
        replays: db.prepare('SELECT * FROM replays WHERE incident_id=? ORDER BY created_at DESC').all(id)
          .map(r => ({ ...JSON.parse(r.result), id: r.id, created_at: r.created_at })) };
    },
    saveReplay(id, result) {
      const replay = { id: randomUUID(), created_at: new Date().toISOString(), ...result };
      db.prepare('INSERT INTO replays VALUES (?,?,?,?)').run(replay.id, id, replay.created_at, JSON.stringify(result));
      return replay;
    },
    resolve(id) { db.prepare("UPDATE incidents SET status='resolved', updated_at=? WHERE id=?").run(new Date().toISOString(), id); },
    metrics() {
      const total = db.prepare("SELECT COUNT(*) AS n FROM events WHERE source='live'").get().n;
      const failed = db.prepare("SELECT COUNT(*) AS n FROM events WHERE status>=500 AND source='live'").get().n;
      const durations = db.prepare("SELECT duration_ms FROM events WHERE source='live' ORDER BY duration_ms").all().map(r => r.duration_ms);
      return { total, failed, errorRate: total ? failed / total * 100 : 0,
        p95: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : 0,
        open: db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE status='open'").get().n };
    },
    timeline() {
      const now = Date.now();
      const rows = db.prepare("SELECT created_at,status FROM events WHERE source='live' AND created_at>=?").all(new Date(now - 60 * 60000).toISOString());
      return Array.from({ length: 30 }, (_, index) => {
        const start = now - (30 - index) * 120000;
        const events = rows.filter(e => Date.parse(e.created_at) >= start && Date.parse(e.created_at) < start + 120000);
        return { time: new Date(start).toISOString(), total: events.length, errors: events.filter(e => e.status >= 500).length };
      });
    },
    close() { db.close(); }
  };
}
