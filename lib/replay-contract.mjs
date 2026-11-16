export const SAMPLE_ADAPTER = 'checkout-sample-v1';
export const MAX_REPLAY_REQUESTS = 20;
export const SAMPLE_REVISIONS = ['baseline','candidate'];
const fail = message => Object.assign(new Error(message),{ status: 409 });

export function selectReplayInputs(incident) {
  if (incident.service !== 'checkout-sample' || incident.title !== 'PaymentSessionExpired') throw fail('No replay adapter is registered for this incident');
  const events = [...incident.events].sort((a,b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0,MAX_REPLAY_REQUESTS);
  if (!events.length) throw fail('No captured requests are available for replay');
  return events.map(event => {
    if (event.method !== 'POST' || event.path !== '/checkout' || event.status !== 500 || !Number.isFinite(event.duration_ms) || event.duration_ms < 0
      || !['expired-session','slow-expired-session'].includes(event.payload?.fixture)) throw fail('Captured requests do not match the checkout replay contract');
    // Never forward arbitrary URLs, headers, payload fields, source code, or credentials.
    return { eventId: event.id,fixture: event.payload.fixture,capturedStatus: event.status,capturedMs: event.duration_ms };
  });
}

export function summarizeTimings(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a,b) => a-b);
  return { meanMs: +(values.reduce((n,v) => n+v,0)/values.length).toFixed(1),
    p50Ms: ordered[Math.ceil(ordered.length*.5)-1],p95Ms: ordered[Math.ceil(ordered.length*.95)-1] };
}
