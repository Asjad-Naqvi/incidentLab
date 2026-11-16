import { randomUUID } from 'node:crypto';

const error = message => Object.assign(new Error(message), { status: 429 });
const readSQLite = row => row ? { ...row, evidence: JSON.parse(row.evidence), result: row.result ? JSON.parse(row.result) : null,
  usage: row.usage ? JSON.parse(row.usage) : null } : null;

export function sqliteAnalyses(db, transaction) {
  db.exec(`CREATE TABLE IF NOT EXISTS incident_analyses (
    id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), base_key TEXT NOT NULL,
    attempt INTEGER NOT NULL, model TEXT NOT NULL, evidence_hash TEXT NOT NULL, evidence TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), result TEXT, usage TEXT, error_code TEXT,
    reserved_microusd INTEGER NOT NULL, cost_microusd INTEGER, budget_day TEXT NOT NULL,
    created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(base_key,attempt));
    CREATE INDEX IF NOT EXISTS analyses_incident ON incident_analyses(incident_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS analyses_day ON incident_analyses(budget_day);`);
  const byKey = key => readSQLite(db.prepare('SELECT * FROM incident_analyses WHERE base_key=? ORDER BY attempt DESC LIMIT 1').get(key));
  const spend = day => db.prepare('SELECT COALESCE(SUM(MAX(reserved_microusd,COALESCE(cost_microusd,0))),0) AS n FROM incident_analyses WHERE budget_day=?').get(day).n;
  return {
    expireAnalyses(now = Date.now()) { db.prepare("UPDATE incident_analyses SET status='failed',error_code='interrupted',completed_at=? WHERE status='pending' AND created_at<?")
      .run(new Date(now).toISOString(), new Date(now - 90000).toISOString()); },
    analysisByKey: byKey,
    latestAnalysis(id) { return readSQLite(db.prepare('SELECT * FROM incident_analyses WHERE incident_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id)); },
    analysisSpend: spend,
    reserveAnalysis(input) {
      return transaction(() => {
        const latest = byKey(input.baseKey);
        if (latest && (latest.status !== 'failed' || !input.retry)) return { created: false, analysis: latest };
        if (latest?.attempt >= 3) throw error('Maximum attempts reached for this evidence snapshot');
        if (spend(input.day) + input.reservedMicros > input.dailyMicros) throw error('Daily analysis budget would be exceeded');
        const id = randomUUID();
        db.prepare(`INSERT INTO incident_analyses (id,incident_id,base_key,attempt,model,evidence_hash,evidence,status,reserved_microusd,budget_day,created_at)
          VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`).run(id,input.incidentId,input.baseKey,(latest?.attempt || 0)+1,input.model,input.evidenceHash,JSON.stringify(input.evidence),input.reservedMicros,input.day,new Date().toISOString());
        return { created: true, analysis: byKey(input.baseKey) };
      });
    },
    finishAnalysis(id, { status, result = null, usage = null, costMicros = null, errorCode = null }) {
      db.prepare("UPDATE incident_analyses SET status=?,result=?,usage=?,cost_microusd=?,error_code=?,completed_at=? WHERE id=? AND status='pending'")
        .run(status,result ? JSON.stringify(result) : null,usage ? JSON.stringify(usage) : null,costMicros,errorCode,new Date().toISOString(),id);
    }
  };
}

export function postgresAnalyses(pool, transaction) {
  const byKey = async (key, client = pool) => (await client.query('SELECT * FROM incident_analyses WHERE base_key=$1 ORDER BY attempt DESC LIMIT 1',[key])).rows[0] || null;
  const spend = async (day, client = pool) => Number((await client.query('SELECT COALESCE(SUM(GREATEST(reserved_microusd,COALESCE(cost_microusd,0))),0) AS n FROM incident_analyses WHERE budget_day=$1',[day])).rows[0].n);
  return {
    async expireAnalyses(now = Date.now()) { await pool.query("UPDATE incident_analyses SET status='failed',error_code='interrupted',completed_at=$1 WHERE status='pending' AND created_at<$2",[new Date(now).toISOString(),new Date(now-90000).toISOString()]); },
    analysisByKey: byKey,
    async latestAnalysis(id) { return (await pool.query('SELECT * FROM incident_analyses WHERE incident_id=$1 ORDER BY created_at DESC,attempt DESC,id DESC LIMIT 1',[id])).rows[0] || null; },
    analysisSpend: spend,
    reserveAnalysis(input) {
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(4317003)');
        const latest = await byKey(input.baseKey,client);
        if (latest && (latest.status !== 'failed' || !input.retry)) return { created: false, analysis: latest };
        if (latest?.attempt >= 3) throw error('Maximum attempts reached for this evidence snapshot');
        if (await spend(input.day,client) + input.reservedMicros > input.dailyMicros) throw error('Daily analysis budget would be exceeded');
        await client.query(`INSERT INTO incident_analyses (id,incident_id,base_key,attempt,model,evidence_hash,evidence,status,reserved_microusd,budget_day,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`,[randomUUID(),input.incidentId,input.baseKey,(latest?.attempt || 0)+1,input.model,input.evidenceHash,JSON.stringify(input.evidence),input.reservedMicros,input.day,new Date().toISOString()]);
        return { created: true, analysis: await byKey(input.baseKey,client) };
      });
    },
    async finishAnalysis(id, { status, result = null, usage = null, costMicros = null, errorCode = null }) {
      await pool.query("UPDATE incident_analyses SET status=$1,result=$2,usage=$3,cost_microusd=$4,error_code=$5,completed_at=$6 WHERE id=$7 AND status='pending'",
        [status,result ? JSON.stringify(result) : null,usage ? JSON.stringify(usage) : null,costMicros,errorCode,new Date().toISOString(),id]);
    }
  };
}
