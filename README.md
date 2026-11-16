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
npm.cmd run dev  # restart the backend when source files change
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

## Boundaries

This is a single-user **local prototype**, bound to `127.0.0.1`. Do not expose it publicly. There is no authentication or multi-tenant isolation yet. Mutation requests with a foreign Origin are rejected; this is not a substitute for production authentication. Only allowlisted demo payload fields are persisted. Replay cannot contact arbitrary URLs or charge a real payment provider.

The investigation explanation is deterministic fixture documentation, **not AI output**. The sample service runs in process; there is no independent SDK, distributed tracing, queue, or third-party ingestion yet. A replay with no server errors verifies only the captured fixture cases.

## Next milestones

- Separate sample service plus an ingestion SDK with payload redaction and authenticated ingestion.
- PostgreSQL migrations and background processing with retries and idempotency.
- AI explanations grounded in captured evidence, with explicit uncertainty and cost limits.
- Isolated replay workers, controlled fault injection, and comparable latency measurements.
- Authentication, workspaces, deployment, CI, load tests, and a measured public demo.

## Portfolio evidence

Record a short failure-to-resolution demo and publish the test output and architecture tradeoffs. Add throughput or latency claims to your résumé only after measuring them. This first milestone proves incident grouping, persisted evidence, recurrence handling, and controlled request replay.
