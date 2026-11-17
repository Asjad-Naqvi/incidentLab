import { randomUUID } from 'node:crypto';

const denied = () => Object.assign(new Error('Too many sign-in attempts. Try again later.'),{ status: 429,retryAfter: 900 });
const existing = () => Object.assign(new Error('The workspace owner already exists'),{ status: 409 });
const WINDOW = 15*60000;
export function sqliteAuth(db,transaction) {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner' CHECK(role='owner'),owner_slot INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(owner_slot=1));
    CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,window_start INTEGER NOT NULL);`);
  return {
    ownerCount() { return db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n; },
    ownerByName(name) { return db.prepare('SELECT id,username,password_hash,role FROM auth_users WHERE username=?').get(name) || null; },
    createOwner(username,passwordHash) {
      return transaction(() => {
        if (db.prepare('SELECT id FROM auth_users LIMIT 1').get()) throw existing();
        const id = randomUUID(); db.prepare('INSERT INTO auth_users (id,username,password_hash) VALUES (?,?,?)').run(id,username,passwordHash);
        return { id,username,role: 'owner' };
      });
    },
    replaceOwnerPassword(username,passwordHash) {
      return transaction(() => {
        const user = db.prepare('SELECT id FROM auth_users WHERE username=?').get(username);
        if (!user) throw new Error('Workspace owner not found');
        db.prepare('UPDATE auth_users SET password_hash=? WHERE id=?').run(passwordHash,user.id);
        db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id); db.exec('DELETE FROM auth_limits');
      });
    },
    recordLoginAttempt(limits,now) {
      return transaction(() => {
        db.prepare('DELETE FROM auth_limits WHERE window_start<=?').run(now-WINDOW);
        for (const limit of limits) if ((db.prepare('SELECT attempts FROM auth_limits WHERE key=?').get(limit.key)?.attempts || 0) >= limit.max) throw denied();
        for (const limit of limits) db.prepare('INSERT INTO auth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=auth_limits.attempts+1').run(limit.key,now);
      });
    },
    clearLoginLimits(keys) { for (const key of keys) db.prepare('DELETE FROM auth_limits WHERE key=?').run(key); },
    createSession(userId,tokenHash,now,expiresAt,passwordHash) {
      transaction(() => {
        if (db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(userId)?.password_hash !== passwordHash) throw Object.assign(new Error('Invalid username or password'),{ status: 401 });
        db.prepare('DELETE FROM auth_sessions WHERE expires_at<=? OR last_seen_at<=?').run(now,now-30*60000);
        db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE user_id=? ORDER BY created_at DESC,token_hash LIMIT 4)').run(userId,userId);
        db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,?)').run(tokenHash,userId,now,expiresAt,now);
      });
    },
    sessionUser(tokenHash,now,touch = true) {
      return transaction(() => {
        const user = db.prepare(`SELECT u.id,u.username,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
          WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>?`).get(tokenHash,now,now-30*60000);
        if (user && touch) db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=?').run(now,tokenHash);
        return user || null;
      });
    },
    deleteSession(hash) { db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash); }
  };
}

export function postgresAuth(pool,transaction) {
  return {
    async ownerCount() { return Number((await pool.query('SELECT COUNT(*) AS n FROM auth_users')).rows[0].n); },
    async ownerByName(name) { return (await pool.query('SELECT id,username,password_hash,role FROM auth_users WHERE username=$1',[name])).rows[0] || null; },
    createOwner(username,passwordHash) {
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(4317004)');
        if ((await client.query('SELECT id FROM auth_users LIMIT 1')).rowCount) throw existing();
        const id = randomUUID(); await client.query('INSERT INTO auth_users (id,username,password_hash) VALUES ($1,$2,$3)',[id,username,passwordHash]);
        return { id,username,role: 'owner' };
      });
    },
    replaceOwnerPassword(username,passwordHash) {
      return transaction(async client => {
        const user = (await client.query('SELECT id FROM auth_users WHERE username=$1 FOR UPDATE',[username])).rows[0];
        if (!user) throw new Error('Workspace owner not found');
        await client.query('UPDATE auth_users SET password_hash=$1 WHERE id=$2',[passwordHash,user.id]);
        await client.query('DELETE FROM auth_sessions WHERE user_id=$1',[user.id]); await client.query('DELETE FROM auth_limits');
      });
    },
    recordLoginAttempt(limits,now) {
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(4317005)');
        await client.query('DELETE FROM auth_limits WHERE window_start<=$1',[now-WINDOW]);
        for (const limit of limits) {
          const row = (await client.query('SELECT attempts FROM auth_limits WHERE key=$1',[limit.key])).rows[0];
          if ((row?.attempts || 0) >= limit.max) throw denied();
        }
        for (const limit of limits) await client.query('INSERT INTO auth_limits VALUES ($1,1,$2) ON CONFLICT(key) DO UPDATE SET attempts=auth_limits.attempts+1',[limit.key,now]);
      });
    },
    async clearLoginLimits(keys) { await pool.query('DELETE FROM auth_limits WHERE key=ANY($1::text[])',[keys]); },
    createSession(userId,tokenHash,now,expiresAt,passwordHash) {
      return transaction(async client => {
        // Serialize session creation and password resets for this account.
        const user = (await client.query('SELECT password_hash FROM auth_users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
        if (user?.password_hash !== passwordHash) throw Object.assign(new Error('Invalid username or password'),{ status: 401 });
        await client.query('DELETE FROM auth_sessions WHERE expires_at<=$1 OR last_seen_at<=$2',[now,now-30*60000]);
        await client.query('DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC,token_hash LIMIT 4)',[userId]);
        await client.query('INSERT INTO auth_sessions VALUES ($1,$2,$3,$4,$3)',[tokenHash,userId,now,expiresAt]);
      });
    },
    async sessionUser(hash,now,touch = true) {
      if (touch) return (await pool.query(`UPDATE auth_sessions s SET last_seen_at=$2 FROM auth_users u
        WHERE u.id=s.user_id AND s.token_hash=$1 AND s.expires_at>$2 AND s.last_seen_at>$3 RETURNING u.id,u.username,u.role`,[hash,now,now-30*60000])).rows[0] || null;
      return (await pool.query(`SELECT u.id,u.username,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.last_seen_at>$3`,[hash,now,now-30*60000])).rows[0] || null;
    },
    async deleteSession(hash) { await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hash]); }
  };
}
