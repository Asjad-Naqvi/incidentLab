import { openStore } from './lib/open-store.mjs';
import { startWorker } from './lib/worker.mjs';

const store = await openStore();
const worker = startWorker(store, { keepAlive: true,
  onError: () => console.error('Worker cycle failed; queued work will be retried') });
console.log(`IncidentLab ingestion worker running (${store.backend})`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.stop(); await store.close(); process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('message', message => { if (message === 'shutdown') void stop(); });
