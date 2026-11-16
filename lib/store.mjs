import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function createStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  `);
  return {
    db,
    isFixed: () => db.prepare("SELECT value FROM settings WHERE key='paymentFixed'").get().value === 'true',
    setFixed(value) { db.prepare("UPDATE settings SET value=? WHERE key='paymentFixed'").run(String(value)); },
    record({ method, path, status, durationMs, error = null, payload = {}, source = 'live' }) {
      const now = new Date().toISOString();
      let incidentId = null;
      if (status >= 500) {
        const fingerprint = `${method}:${path}:${error}`;
        const existing = db.prepare('SELECT id FROM incidents WHERE fingerprint=?').get(fingerprint);
        incidentId = existing?.id ?? randomUUID();
        if (existing) db.prepare("UPDATE incidents SET updated_at=?, status='open' WHERE id=?").run(now, incidentId);
        else db.prepare('INSERT INTO incidents (id,fingerprint,title,service,severity,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(incidentId, fingerprint, error || 'Unhandled service error', 'checkout-api', 'critical', now, now);
      }
      const id = randomUUID();
      db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, incidentId, now, method, path, status, durationMs, error, JSON.stringify(payload), source);
      return { id, incidentId };
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
