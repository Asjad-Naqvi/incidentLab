export async function processNextJob(store, { now = Date.now(), maxAttempts = 5, beforeCommit = async () => {} } = {}) {
  const job = await store.claimJob(now);
  if (!job) return false;
  try {
    await beforeCommit(job.event);
    await store.completeJob(job);
  } catch {
    // Do not persist arbitrary exception messages, which may contain credentials or payloads.
    await store.failJob(job, { now, maxAttempts, reason: 'Event processing failed' });
  }
  return true;
}

export function startWorker(store, { onUpdate = () => {}, intervalMs = 250, keepAlive = false, onError = () => {} } = {}) {
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
    })().catch(() => { onError(); /* Durable jobs remain queued or recover after lease expiry. */ })
      .finally(() => { active = null; });
  };
  const timer = setInterval(tick, intervalMs); if (!keepAlive) timer.unref();
  return { async stop() { stopping = true; clearInterval(timer); await active; } };
}
