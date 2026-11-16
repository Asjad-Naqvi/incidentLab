import { parentPort, workerData } from 'node:worker_threads';
import { checkout } from '../sample/checkout.mjs';
import { SAMPLE_ADAPTER, MAX_REPLAY_REQUESTS, SAMPLE_REVISIONS, summarizeTimings } from './replay-contract.mjs';
import { createHash } from 'node:crypto';

const { requests,revision } = workerData;
if (!SAMPLE_REVISIONS.includes(revision) || !Array.isArray(requests) || !requests.length || requests.length > MAX_REPLAY_REQUESTS) throw new Error('Invalid replay contract');
const results = [];
for (const [index,request] of requests.entries()) {
  if (!['expired-session','slow-expired-session'].includes(request.fixture)) throw new Error('Invalid fixture');
  const payload = { fixture: request.fixture,amount: 49 };
  let baseline; let candidate;
  // Alternate pair order to avoid always measuring the candidate after the baseline.
  if (index % 2) { candidate = await checkout(payload,revision === 'candidate'); baseline = await checkout(payload,false); }
  else { baseline = await checkout(payload,false); candidate = await checkout(payload,revision === 'candidate'); }
  results.push({ eventId: request.eventId,capturedStatus: request.capturedStatus,capturedMs: request.capturedMs,
    beforeStatus: baseline.status,afterStatus: candidate.status,beforeMs: baseline.durationMs,afterMs: candidate.durationMs });
}
const beforeErrors = results.filter(r => r.beforeStatus >= 500).length;
const afterErrors = results.filter(r => r.afterStatus >= 500).length;
const reproduced = results.filter(r => r.beforeStatus === r.capturedStatus).length;
const implementationHash = createHash('sha256').update(checkout.toString()).digest('hex');
parentPort.postMessage({ state: 'completed',adapter: SAMPLE_ADAPTER,isolation: 'worker-thread',revision,
  implementationHash,count: results.length,beforeErrors,afterErrors,reproduced,
  beforeErrorRate: beforeErrors/results.length*100,afterErrorRate: afterErrors/results.length*100,
  beforeLatency: summarizeTimings(results.map(r => r.beforeMs)),afterLatency: summarizeTimings(results.map(r => r.afterMs)),
  verificationPassed: revision === 'candidate' && reproduced === results.length && afterErrors === 0,
  results,liveServiceChanged: false });
parentPort.close();
