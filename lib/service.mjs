import { checkout } from '../sample/checkout.mjs';
export { checkout } from '../sample/checkout.mjs';

export async function replayIncident(store, id) {
  const incident = await store.incident(id);
  if (!incident) return null;
  if (incident.service !== 'checkout-api') throw Object.assign(new Error('Replay is currently limited to the built-in checkout fixture. External services require an isolated replay adapter.'), { status: 409 });
  // Allowlisted fixture only: captured URLs never become arbitrary network requests.
  const events = incident.events.filter(e => e.path === '/demo/checkout' && e.method === 'POST').slice(0, 100);
  if (!events.length) throw new Error('No replayable checkout requests');
  const fixed = await store.isFixed();
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
