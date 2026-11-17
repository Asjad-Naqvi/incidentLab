CREATE TABLE auth_users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role='owner'),
  owner_slot INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (owner_slot=1)
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL
);
CREATE INDEX auth_session_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start BIGINT NOT NULL
);
