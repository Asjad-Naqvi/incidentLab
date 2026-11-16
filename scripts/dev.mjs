import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { localIngestionKey, projectRoot } from '../lib/config.mjs';

const key = localIngestionKey();
const port = process.env.PORT || '4317';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const script of ['server.mjs', 'sample/server.mjs']) {
  const child = spawn(process.execPath, ['--experimental-sqlite', join(projectRoot, script)], {
    cwd: projectRoot, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, INCIDENTLAB_INGESTION_KEY: key, INCIDENTLAB_ENDPOINT: `http://127.0.0.1:${port}` }
  });
  children.push(child);
  child.on('error', error => { console.error(`Unable to start ${script}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
