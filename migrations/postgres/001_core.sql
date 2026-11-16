CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('paymentFixed', 'false');
CREATE TABLE incidents (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  service TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, incident_id TEXT REFERENCES incidents(id), created_at TEXT NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
  duration_ms DOUBLE PRECISION NOT NULL CHECK (duration_ms >= 0), error TEXT,
  payload JSONB NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL
);
CREATE TABLE replays (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
  created_at TEXT NOT NULL, result JSONB NOT NULL
);
CREATE INDEX events_incident ON events(incident_id, created_at DESC);
CREATE INDEX events_live_time ON events(source, created_at);
