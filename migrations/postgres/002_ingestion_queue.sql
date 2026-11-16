CREATE TABLE ingestion_jobs (
  id TEXT PRIMARY KEY, event JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','complete','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), available_at BIGINT NOT NULL,
  lease_until BIGINT, last_error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX jobs_ready ON ingestion_jobs(state, available_at, created_at);
CREATE INDEX jobs_leased ON ingestion_jobs(lease_until) WHERE state='processing';
