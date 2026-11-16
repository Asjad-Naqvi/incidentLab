# IncidentLab Node SDK

Server-side, dependency-free telemetry client. This package is local-only and is not published to npm.

Install from a checkout with `npm install /absolute/path/to/incidentlab/sdk`, then import `createClient` from `@incidentlab/node`. The included sample imports the module directly.

```js
import { createClient } from '@incidentlab/node';

const telemetry = createClient({
  endpoint: process.env.INCIDENTLAB_ENDPOINT,
  apiKey: process.env.INCIDENTLAB_INGESTION_KEY,
  service: 'orders-api',
  payloadKeys: [], // Request bodies are excluded by default.
  onError: error => console.warn(error.message),
});

telemetry.capture({
  method: 'GET',
  path: '/orders/:id', // Use a route template, never concrete identifiers or query strings.
  status: 500,
  durationMs: 42.5,
  errorType: 'DatabaseTimeout', // A short error class; no free-form exception messages.
});

// Call during graceful shutdown, after your HTTP server has drained.
await telemetry.close();
```

`capture()` returns `true` if accepted into the in-memory client queue and `false` on invalid input, a closed client, or capacity exhaustion. It does not throw telemetry validation or callback errors into the application's request handler. This is not a delivery acknowledgment.

The default queue holds 500 events, flushes every second, batches at most 25, and retries transient failures three times with bounded exponential backoff. `flush()` returns `{ delivered, pending }` and concurrent calls share one operation. The same UUIDs are retained during retries. HTTP 401/403 and other permanent 4xx errors are not retried within a flush; retained data can be delivered after fixing configuration. 408, 429, 5xx, and network errors are transient. Redirects are rejected and requests time out after three seconds by default. The server accepts only 202 as the durable-enqueue acknowledgment.

Only the collector queue is durable. Unflushed SDK events are lost on an application crash, and a failed shutdown flush can leave events undelivered. SDK memory is bounded; capture returns false when full. These tradeoffs keep telemetry separate from request success. Error callbacks receive generic diagnostics, not credentials, response bodies, or captured payloads.

No headers are captured. Payload fields require explicit top-level opt-in using `payloadKeys`; nested sensitive keys and recognizable credential/email strings are redacted. Redaction cannot identify every secret or personal value. Never opt sensitive data into telemetry. Remote collectors require HTTPS, and bearer credentials must stay on the server.
