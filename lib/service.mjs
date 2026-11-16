// Controlled fixture: no external payment provider is contacted.
export async function checkout(payload, fixed) {
  const start = performance.now();
  await new Promise(resolve => setTimeout(resolve, 18));
  const expired = payload.fixture === 'expired-session';
  if (expired && !fixed) return { status: 500, durationMs: +(performance.now() - start).toFixed(1),
    error: 'PaymentSessionExpired: unhandled session expiry', body: { error: 'Payment session expired' } };
  return { status: expired ? 409 : 200, durationMs: +(performance.now() - start).toFixed(1),
    error: null, body: expired ? { error: 'Session expired. Start a new checkout.', recoverable: true } : { orderId: 'demo-order', accepted: true } };
}

export async function replayIncident(store, id) {
  const incident = store.incident(id);
  if (!incident) return null;
  // Allowlisted fixture only: captured URLs never become arbitrary network requests.
  const events = incident.events.filter(e => e.path === '/demo/checkout' && e.method === 'POST').slice(0, 100);
  if (!events.length) throw new Error('No replayable checkout requests');
  const fixed = store.isFixed();
  const results = [];
  for (const event of events) {
    const result = await checkout(event.payload, fixed);
    results.push({ eventId: event.id, beforeStatus: event.status, afterStatus: result.status,
      beforeMs: event.duration_ms, afterMs: result.durationMs });
  }
  const beforeErrors = results.filter(r => r.beforeStatus >= 500).length;
  const afterErrors = results.filter(r => r.afterStatus >= 500).length;
  return store.saveReplay(id, { count: results.length, beforeErrors, afterErrors, fixed,
    beforeErrorRate: beforeErrors / results.length * 100, afterErrorRate: afterErrors / results.length * 100,
    results });
}
