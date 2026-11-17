// Shared HTTP defaults for both the owner application and the public demo.
export const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
export function securityHeaders(res, { secure = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('Cache-Control', 'no-store');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
export function configureHttp(server, { logRequests = false, logger = console.log } = {}) {
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.maxConnections = 128;
  server.on('request', (req, res) => {
    if (!logRequests) return;
    const started = performance.now();
    // Deliberately omit URLs, bodies, IP addresses, cookies and credentials.
    res.once('finish', () => logger(JSON.stringify({ event: 'http_request', method: req.method,
      status: res.statusCode, durationMs: Math.round(performance.now() - started) })));
  });
  return server;
}
export function deploymentOrigin(env = process.env) {
  const value = env.INCIDENTLAB_PUBLIC_ORIGIN || (env.RENDER === 'true' ? env.RENDER_EXTERNAL_URL : undefined);
  if (env.RENDER === 'true' && !value) throw new Error('Render public URL is required');
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid public origin');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Public deployments require HTTPS');
  return url.origin;
}
export async function shutdown(server, close, { timeoutMs = 10000 } = {}) {
  const timer = setTimeout(() => { console.error('Shutdown deadline exceeded'); process.exit(1); }, timeoutMs);
  timer.unref();
  try {
    // Reject new connections first, then end streams and drain active work.
    const closed = server.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    await server.stopWorker?.();
    server.closeAllConnections();
    await closed;
    await close?.();
  } finally { clearTimeout(timer); }
}
