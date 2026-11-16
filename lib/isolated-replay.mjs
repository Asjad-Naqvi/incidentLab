import { Worker } from 'node:worker_threads';
import { selectReplayInputs, SAMPLE_ADAPTER, SAMPLE_REVISIONS } from './replay-contract.mjs';

export function createReplayRunner({ timeoutMs = 10000, WorkerClass = Worker } = {}) {
  const active = new Set();
  let closed = false;
  return {
    run(requests,revision) {
      if (closed) return Promise.reject(new Error('Replay runner is closed'));
      return new Promise((resolve,reject) => {
        const worker = new WorkerClass(new URL('./replay-thread.mjs',import.meta.url),{
          workerData: { requests,revision },env: {},execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 32,maxYoungGenerationSizeMb: 8,stackSizeMb: 2 }
        });
        let settled = false;
        let settlement;
        const settle = (error,result) => {
          if (settled) return settlement;
          settled = true; clearTimeout(timer);
          settlement = (async () => {
            try { await worker.terminate(); }
            catch { error ||= Object.assign(new Error('Replay worker termination failed'),{ code: 'worker_failed' }); }
            active.delete(cancel);
            if (error) reject(error); else resolve(result);
          })();
          return settlement;
        };
        const cancel = () => settle(Object.assign(new Error('Replay cancelled'),{ code: 'cancelled' }));
        active.add(cancel);
        const timer = setTimeout(() => { void settle(Object.assign(new Error('Replay deadline exceeded'),{ code: 'timeout' })); },timeoutMs);
        worker.once('message',result => { void settle(null,result); });
        worker.once('error',() => { void settle(Object.assign(new Error('Replay worker failed'),{ code: 'worker_failed' })); });
        worker.once('exit',() => { if (!settled) void settle(Object.assign(new Error('Replay worker exited without a result'),{ code: 'worker_failed' })); });
      });
    },
    async close() { closed = true; await Promise.all([...active].map(cancel => cancel())); }
  };
}

export async function replaySampleIncident(store,incident,revision,runner) {
  if (!SAMPLE_REVISIONS.includes(revision)) throw Object.assign(new Error('Revision must be baseline or candidate'),{ status: 400 });
  const requests = selectReplayInputs(incident);
  const startedAt = new Date().toISOString();
  let result;
  try { result = await runner.run(requests,revision); }
  catch (error) {
    result = { state: 'failed',adapter: SAMPLE_ADAPTER,isolation: 'worker-thread',revision,count: requests.length,
      errorCode: ['timeout','cancelled'].includes(error.code) ? error.code : 'worker_failed',results: [],verificationPassed: false,liveServiceChanged: false };
  }
  return store.saveReplay(incident.id,{ ...result,startedAt,finishedAt: new Date().toISOString(),
    sampledFrom: incident.events.length,limitations: 'Paired measurements in the bundled sample adapter. This does not verify a deployed fix or replay arbitrary service code.' });
}
