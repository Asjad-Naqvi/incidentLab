const port = process.env.SAMPLE_PORT || '4318';
const statuses = {};
const slow = process.argv.includes('--slow');
try {
  for (let i = 0; i < 12; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: i % 3 === 0 ? (slow ? 'slow-expired-session' : 'expired-session') : 'valid-session', amount: 49 }),
      signal: AbortSignal.timeout(5000)
    });
    await response.arrayBuffer(); statuses[response.status] = (statuses[response.status] || 0) + 1;
  }
  console.log('Sent 12 requests to the separate checkout service:', statuses);
  console.log('Telemetry flushes automatically. Watch Connected services in the dashboard.');
} catch { console.error('Sample service unavailable. Run npm.cmd run dev first.'); process.exitCode = 1; }
