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
  for (const child of children) {
    if (child.connected) child.send('shutdown', () => {}); else child.kill('SIGTERM');
  }
  const deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); }, 8000);
  deadline.unref();
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
for (const script of ['server.mjs', 'worker.mjs', 'sample/server.mjs']) {
  const childEnv = { ...process.env, INCIDENTLAB_WORKER_MODE: 'external', INCIDENTLAB_INGESTION_KEY: key, INCIDENTLAB_ENDPOINT: `http://127.0.0.1:${port}` };
  if (script !== 'server.mjs') delete childEnv.OPENAI_API_KEY;
  const child = spawn(process.execPath, ['--experimental-sqlite', join(projectRoot, script)], {
    cwd: projectRoot, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    env: childEnv
  });
  children.push(child);
  child.on('error', error => { console.error(`Unable to start ${script}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
process.on('message', message => { if (message === 'shutdown') stop(); });
