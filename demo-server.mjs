import { createDemoServer } from './lib/demo.mjs';
import { deploymentOrigin, shutdown } from './lib/http-security.mjs';

// This entry point deliberately ignores DATABASE_URL and ingestion credentials.
const publicOrigin = deploymentOrigin();
if (process.env.NODE_ENV === 'production' && !publicOrigin?.startsWith('https:')) throw new Error('Set an HTTPS public origin for the hosted demo');
const server = createDemoServer({ publicOrigin, logRequests: true });
const port = Number(process.env.PORT || 4318);
server.listen(port, process.env.INCIDENTLAB_HOST || '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', mode: 'demo', port: server.address().port })));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  try { await shutdown(server); if (process.connected) process.disconnect(); } catch { console.error('Demo shutdown failed'); process.exitCode = 1; }
}
server.on('error', () => { console.error('Demo server failed'); process.exitCode = 1; void stop(); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('message', message => { if (message === 'shutdown') void stop(); });
