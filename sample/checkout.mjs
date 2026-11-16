// Trusted sample implementation shared by the HTTP service and its replay adapter.
// All timing and fault behavior is simulated; no payment provider is contacted.
export async function checkout(payload, fixed) {
  const start = performance.now();
  const expired = ['expired-session','slow-expired-session'].includes(payload.fixture);
  const delay = payload.fixture === 'slow-expired-session' && !fixed ? 98 : 18;
  await new Promise(resolve => setTimeout(resolve,delay));
  if (expired && !fixed) return { status: 500,durationMs: +(performance.now()-start).toFixed(1),
    error: 'PaymentSessionExpired: unhandled session expiry',body: { error: 'Payment session expired' } };
  return { status: expired ? 409 : 200,durationMs: +(performance.now()-start).toFixed(1),error: null,
    body: expired ? { error: 'Session expired. Start a new checkout.',recoverable: true } : { orderId: 'demo-order',accepted: true } };
}
