import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createClient } from '../sdk/index.mjs';
import { checkout } from '../lib/service.mjs';
import { localIngestionKey } from '../lib/config.mjs';

export function createSampleService({ client, fixed = false }) {
  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/healthz') return send(200, { status: 'ok', service: 'checkout-sample', fixed });
    if (req.method !== 'POST' || req.url !== '/checkout') return send(404, { error: 'Not found' });
    if (req.headers.origin) return send(403, { error: 'Use the server-side demo client' });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return send(413, { error: 'Payload too large' }); chunks.push(chunk); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!payload || !['valid-session', 'expired-session'].includes(payload.fixture)) return send(400, { error: 'Invalid fixture' });
      const result = await checkout(payload, fixed);
      client.capture({ method: 'POST', path: '/checkout', status: result.status, durationMs: result.durationMs,
        errorType: result.status >= 500 ? 'PaymentSessionExpired' : null, payload });
      send(result.status, result.body);
    } catch { send(400, { error: 'Invalid request' }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const client = createClient({ endpoint: process.env.INCIDENTLAB_ENDPOINT || 'http://127.0.0.1:4317',
    apiKey: localIngestionKey(), service: 'checkout-sample', payloadKeys: ['fixture', 'amount'],
    onError: error => console.error(`[telemetry] ${error.message}`) });
  const server = createSampleService({ client, fixed: process.env.SAMPLE_FIXED === '1' });
  const port = Number(process.env.SAMPLE_PORT || 4318);
  server.listen(port, '127.0.0.1', () => console.log(`Sample checkout service ready at http://127.0.0.1:${port}`));
  server.on('error', async error => { console.error(error.message); await client.close(); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => { await client.close(); process.exit(0); }); server.closeAllConnections();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
