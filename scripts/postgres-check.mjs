import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectRoot } from '../lib/config.mjs';

let embedded;
let directory;
let child;
const databaseLogs = [];
let phase = 'configuration';
try {
  let connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    directory = await mkdtemp(join(tmpdir(), 'incidentlab-postgres-'));
    const password = randomBytes(24).toString('hex');
    embedded = new EmbeddedPostgres({ databaseDir: join(directory, 'cluster'), port,
      user: 'postgres', password, persistent: true, authMethod: 'scram-sha-256',
      initdbFlags: ['--locale=C', '--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1',...(process.platform === 'win32' ? ['-c','io_method=sync'] : [])],
      onLog: line => databaseLogs.push(String(line)), onError: () => {} });
    phase = 'initialization';
    await embedded.initialise();
    phase = 'startup';
    await embedded.start();
    phase = 'database creation';
    const admin = embedded.getPgClient('postgres', '127.0.0.1');
    try { await admin.connect(); await admin.query('CREATE DATABASE incidentlab_test'); }
    finally { await admin.end(); }
    connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/incidentlab_test`;
    console.log('Started isolated PostgreSQL test cluster');
  }
  phase = 'tests';
  child = spawn(process.execPath, ['--experimental-sqlite', '--test', 'test/postgres.test.mjs'], {
    cwd: projectRoot, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TEST_DATABASE_URL: connectionString }
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} catch (error) {
  console.error(`PostgreSQL ${phase} failed (${error.code || error.name}). Use TEST_DATABASE_URL for an existing test database.`);
  console.error(databaseLogs.slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  if (embedded) { try { await embedded.stop(); } catch { process.exitCode = 1; } }
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
