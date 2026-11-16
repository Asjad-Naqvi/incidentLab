import EmbeddedPostgres from 'embedded-postgres';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { projectRoot } from '../lib/config.mjs';
import { postgresPool } from '../lib/postgres-store.mjs';
import { migratePostgres } from '../lib/postgres-migrations.mjs';

const directory = join(projectRoot, 'data');
await mkdir(directory, { recursive: true });
const configPath = join(directory, 'postgres-local.json');
try { await writeFile(configPath, JSON.stringify({ password: randomBytes(24).toString('hex') }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const { password } = JSON.parse(await readFile(configPath, 'utf8'));
if (typeof password !== 'string' || !/^[a-f0-9]{48}$/.test(password)) throw new Error('Invalid local PostgreSQL configuration');
const port = Number(process.env.PG_DEV_PORT || 54329);
const clusterPath = join(directory, 'postgres');
const database = new EmbeddedPostgres({ databaseDir: clusterPath, user: 'incidentlab', password, port,
  persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--locale=C', '--encoding=UTF8'],
  postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
let started = false;
let child;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child?.connected) child.send('shutdown', () => {}); else child?.kill('SIGTERM');
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('message', message => { if (message === 'shutdown') void stop(); });
try {
  let initialized = false;
  try { await access(join(clusterPath, 'PG_VERSION')); initialized = true; } catch { /* First local launch. */ }
  if (!initialized) await database.initialise();
  await database.start(); started = true;
  const connectionString = `postgresql://incidentlab:${password}@127.0.0.1:${port}/incidentlab`;
  const admin = postgresPool(`postgresql://incidentlab:${password}@127.0.0.1:${port}/postgres`);
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname='incidentlab'");
    if (!existing.rowCount) await admin.query('CREATE DATABASE incidentlab');
  } finally { await admin.end(); }
  const pool = postgresPool(connectionString);
  try { await migratePostgres(pool); } finally { await pool.end(); }
  console.log(`Local PostgreSQL ready on port ${port}; starting collector, worker, and sample service`);
  child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: projectRoot, windowsHide: true,
    env: { ...process.env, DATABASE_URL: connectionString }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(stopping ? 0 : (code ?? 1))); });
} catch {
  console.error('PostgreSQL dev launch failed. Check port availability, dependencies, and the local data directory.'); process.exitCode = 1;
} finally { if (started) await database.stop(); if (process.connected) process.disconnect(); }
