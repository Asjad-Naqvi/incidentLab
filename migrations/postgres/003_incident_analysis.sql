CREATE TABLE incident_analyses (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
  base_key TEXT NOT NULL, attempt INTEGER NOT NULL, model TEXT NOT NULL,
  evidence_hash TEXT NOT NULL, evidence JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  result JSONB, usage JSONB, error_code TEXT,
  reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd > 0),
  cost_microusd INTEGER, budget_day TEXT NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(base_key,attempt)
);
CREATE INDEX analyses_incident ON incident_analyses(incident_id,created_at DESC);
CREATE INDEX analyses_day ON incident_analyses(budget_day);
