export async function processNextJob(store, { now = Date.now(), maxAttempts = 5, beforeCommit = async () => {} } = {}) {
  const job = store.claimJob(now);
  if (!job) return false;
  try {
    await beforeCommit(job.event);
    store.completeJob(job);
  } catch {
    // Do not persist arbitrary exception messages, which may contain credentials or payloads.
    store.failJob(job, { now, maxAttempts, reason: 'Event processing failed' });
  }
  return true;
}

export function startWorker(store, { onUpdate = () => {}, intervalMs = 250 } = {}) {
  let stopping = false;
  let active = null;
  const tick = () => {
    if (stopping || active) return;
    active = (async () => {
      let changed = false;
      for (let i = 0; i < 50 && !stopping; i++) {
        if (!await processNextJob(store)) break;
        changed = true;
      }
      if (changed) onUpdate();
    })().catch(() => { /* Durable jobs remain queued or are recovered after lease expiry. */ })
      .finally(() => { active = null; });
  };
  const timer = setInterval(tick, intervalMs); timer.unref();
  return { async stop() { stopping = true; clearInterval(timer); await active; } };
}
