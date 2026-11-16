# IncidentLab

A local incident investigation platform: capture a service failure, inspect its evidence, replay captured requests, and measure what changes after a fix.

## Run

Requires **Node.js 22.14 or later**. No dependencies, account, GPU, or API key required.

```powershell
cd incidentlab
npm.cmd start
```

Open **http://127.0.0.1:4317**. On Windows, `npm.cmd` avoids PowerShell execution-policy restrictions on `npm.ps1`.

```powershell
npm.cmd run dev  # collector + separate checkout service
npm.cmd run sample:traffic # in a second terminal: exercise the separate service
npm.cmd run dev:collector # collector only, with backend file watching
npm.cmd test     # integration and persistence tests
```

Node 22's built-in SQLite module is experimental; the scripts explicitly enable it. Runtime data lives in `data/incidentlab.sqlite` and is ignored by Git. Stop the server before backing up or removing runtime data. Set `PORT` to use another local port.

## Try the complete workflow

1. **Generate demo traffic** sends twelve actual in-process requests through the checkout fixture. Four use expired sessions and return HTTP 500 while the bug is enabled.
2. Open the resulting incident. Repeated failures with the same method, path, and error are grouped together.
3. **Replay captured requests** before applying the fix: the server errors reproduce.
4. **Apply demo fix** changes the fixture's session handling. It is a runtime switch, not an automatically generated code patch.
5. Replay again. Expired sessions now return a handled HTTP 409, reducing the server error rate to zero in that replay. They do **not** become successful purchases.
6. **Mark resolved** becomes valid after successful replay evidence with the fix enabled. Reintroducing the bug and generating failures reopens the incident.
7. Visit **Replay history** to inspect saved results. Reload or restart: SQLite preserves evidence and fixture state.

## Architecture

- `server.mjs`: native Node HTTP API, static assets, server-sent live updates, and local mutation boundaries.
- `lib/store.mjs`: SQLite incidents, captured events, settings, metrics, and replay evidence.
- `lib/service.mjs`: controlled checkout fixture and replay execution.
- `sdk/`: installable local Node SDK with payload opt-in, redaction, bounded buffering and retries.
- `sample/server.mjs`: independently running checkout HTTP service, instrumented through the SDK.
- `lib/worker.mjs`: background ingestion processing, retry backoff and lease recovery.
- `public/`: responsive, accessible dashboard with search, status filters, an investigation drawer, and replay history.
- `test/`: end-to-end HTTP workflow, recurrence, input handling, and durable-storage checks.

Only original captured traffic contributes to live metrics. Replays are stored separately. p95 is measured across all captured live requests; the activity chart shows the last hour in two-minute buckets. Incident request lists show the newest twenty failures, replay tables the first ten results, and replay executes up to one hundred captured failures.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/overview` | Metrics, grouped incidents, chart and fixture state |
| GET | `/api/stream` | Server-sent events for refresh notifications |
| GET | `/api/incidents/:id` | Captured failures and replay evidence |
| POST | `/api/demo/traffic` | Generate twelve fixture requests |
| POST | `/api/demo/fix` | Enable handled session expiry |
| POST | `/api/demo/break` | Reintroduce the fixture bug |
| POST | `/demo/checkout` | Execute and capture an allowlisted fixture request |
| POST | `/api/incidents/:id/replay` | Replay captured failures against the local fixture |
| POST | `/api/incidents/:id/resolve` | Resolve after successful fixed replay evidence |
| POST | `/api/v1/events` | Authenticated, validated telemetry batch; returns 202 after durable enqueue |
| GET | `/healthz` | Collector liveness |

## External service milestone (v0.2)

Run `npm.cmd run dev` to start the collector on port **4317** and sample checkout on **4318** as separate OS processes. In a second terminal, run `npm.cmd run sample:traffic`. Twelve HTTP requests reach the sample; its SDK sends telemetry over HTTP to the collector. After the next SDK flush and worker cycle, **Connected services** shows `checkout-sample`, and expired sessions create a service-specific incident. Existing in-process fixture buttons still support the original replay workflow.

`npm.cmd start` runs only the collector. `npm.cmd run sample` runs only the sample. The local applications share a generated credential in ignored `data/ingestion-key`; credentials are never printed or returned to the dashboard. For explicit configuration, export `INCIDENTLAB_INGESTION_KEY` (at least 24 characters) in both server processes, and optionally `INCIDENTLAB_ENDPOINT` in the sample. `.env.example` documents configuration, but files are not automatically loaded. Port overrides use `PORT` for the collector and `SAMPLE_PORT` for the sample. The dev launcher passes the collector endpoint to its sample child.

To demonstrate handled expiry in the external sample, set `SAMPLE_FIXED=1` before restarting it. New requests return 409 rather than 500. This does not automatically resolve or replay an external incident. External incidents show actual service names, route templates, error classes and sanitized attributes; they do not receive the built-in fixture's canned explanation.

See [SDK documentation](sdk/README.md) for integrating another Node application. The SDK package is local-only; no npm publication has been made.

### Delivery guarantees

The collector authenticates `Authorization: Bearer <key>` before reading a batch, limits bodies to 64 KiB, and accepts 1–25 validated events per batch. Unknown fields and headers are not persisted. Route templates exclude query strings; error classes exclude free-form exception messages. `checkout-api` is a reserved fixture identity. A valid key authorizes submission under other service names within this **single local workspace**; keys are not yet scoped per service or tenant.

An accepted batch is redacted and committed to SQLite before HTTP 202. Its UUIDs provide idempotency: resubmitting identical normalized content is acknowledged without double-counting, while conflicting content returns 409 and rolls back the whole batch. A background worker uses 30-second leases, performs event insertion and job acknowledgment in one transaction, and retries processing errors with exponential backoff up to five attempts before dead-lettering. Stale lease holders cannot commit. Queued work and abandoned leases survive collector restart.

The pending collector queue is capped at 10,000 entries; overflow returns 429. Completed job IDs and telemetry are retained indefinitely in this prototype so retries remain deduplicated. Retention policies and a dead-letter inspection/retry UI remain future work. The worker runs in the collector process; it is not a separately deployed worker fleet. The SDK's bounded client-side buffer is **in memory**, so an application crash can lose events that have not received collector acknowledgment.

### CI

`.github/workflows/test.yml` runs the integration suite on Windows and Ubuntu with Node 22 and 24 for main-branch pushes and pull requests. No secrets or external services are needed. The tests cover authentication, validation, payload redaction, retry/idempotency, atomic rollback, lease recovery, migration compatibility and end-to-end sample ingestion.

## Boundaries

This is a single-user **local prototype**, bound to `127.0.0.1`. Do not expose it publicly. The ingestion API uses a bearer key; dashboard reads and fixture controls have no user authentication or multi-tenant isolation. Mutation requests with a foreign Origin are rejected; this is not a substitute for production authentication. SDK payloads are explicitly opted in and redacted, but redaction is not a guarantee against every sensitive value. Replay cannot contact arbitrary URLs or charge a real payment provider.

The built-in investigation explanation is deterministic fixture documentation, **not AI output**. External SDK telemetry uses a durable local ingestion queue; distributed tracing and multi-tenant isolation are not implemented. A replay with no server errors verifies only the captured built-in fixture cases. External replay is deliberately unavailable until an isolated adapter is implemented.

## Next milestones

- [x] Separate sample service plus an ingestion SDK with payload redaction and authenticated ingestion.
- [x] Durable SQLite ingestion queue, retries, idempotency, lease recovery and compatibility migration.
- [x] CI matrix covering Windows/Ubuntu and Node 22/24 (workflow configured; hosted results depend on GitHub Actions).
- [ ] PostgreSQL storage adapter, versioned SQL migrations and separately deployed workers.
- [ ] AI explanations grounded in captured evidence, with explicit uncertainty and cost limits.
- [ ] Isolated replay workers, controlled fault injection, and comparable latency measurements.
- [ ] Dashboard authentication, workspaces, deployment, load tests, and a measured public demo.

## Portfolio evidence

Record a short failure-to-resolution demo and publish the test output and architecture tradeoffs. Add throughput or latency claims to your résumé only after measuring them. This first milestone proves incident grouping, persisted evidence, recurrence handling, and controlled request replay.
