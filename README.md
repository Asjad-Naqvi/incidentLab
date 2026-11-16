# IncidentLab

A local incident investigation platform: capture a service failure, inspect its evidence, replay captured requests, and measure what changes after a fix.

## Run

Requires **Node.js 22.14 or later**. No account, GPU, or model API key is required. Install dependencies once:

```powershell
cd incidentlab
npm.cmd ci
npm.cmd start
```

Open **http://127.0.0.1:4317**. On Windows, `npm.cmd` avoids PowerShell execution-policy restrictions on `npm.ps1`.

```powershell
npm.cmd run dev  # SQLite collector + independent worker + checkout service
npm.cmd run dev:postgres # local PostgreSQL + migrations + the same three application processes
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
- `worker.mjs`: independently deployable ingestion-worker entry point.
- `lib/open-store.mjs`: selects PostgreSQL using `DATABASE_URL`, otherwise SQLite.
- `lib/postgres-store.mjs`: asynchronous PostgreSQL storage adapter and transactional queue operations.
- `migrations/postgres/`: ordered SQL migrations with a checksum-verified migration history.
- `lib/analysis.mjs`: bounded evidence snapshots, OpenAI structured responses, validation and analysis orchestration.
- `lib/analysis-storage.mjs`: durable analysis caching and budget reservations for both databases.
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
| GET | `/api/incidents/:id/analysis` | Saved analysis, evidence snapshot and budget/configuration status; no provider request |
| POST | `/api/incidents/:id/analysis` | Analyze the current snapshot, or return its cached result |
| POST | `/api/incidents/:id/analysis?retry=1` | Explicitly retry a failed snapshot, with another budget reservation |

## External service milestone (v0.2)

Run `npm.cmd run dev` to start the collector on port **4317** and sample checkout on **4318** as separate OS processes. In a second terminal, run `npm.cmd run sample:traffic`. Twelve HTTP requests reach the sample; its SDK sends telemetry over HTTP to the collector. After the next SDK flush and worker cycle, **Connected services** shows `checkout-sample`, and expired sessions create a service-specific incident. Existing in-process fixture buttons still support the original replay workflow.

`npm.cmd start` runs only the collector. `npm.cmd run sample` runs only the sample. The local applications share a generated credential in ignored `data/ingestion-key`; credentials are never printed or returned to the dashboard. For explicit configuration, export `INCIDENTLAB_INGESTION_KEY` (at least 24 characters) in both server processes, and optionally `INCIDENTLAB_ENDPOINT` in the sample. `.env.example` documents configuration, but files are not automatically loaded. Port overrides use `PORT` for the collector and `SAMPLE_PORT` for the sample. The dev launcher passes the collector endpoint to its sample child.

To demonstrate handled expiry in the external sample, set `SAMPLE_FIXED=1` before restarting it. New requests return 409 rather than 500. This does not automatically resolve or replay an external incident. External incidents show actual service names, route templates, error classes and sanitized attributes; they do not receive the built-in fixture's canned explanation.

See [SDK documentation](sdk/README.md) for integrating another Node application. The SDK package is local-only; no npm publication has been made.

### Delivery guarantees

The collector authenticates `Authorization: Bearer <key>` before reading a batch, limits bodies to 64 KiB, and accepts 1–25 validated events per batch. Unknown fields and headers are not persisted. Route templates exclude query strings; error classes exclude free-form exception messages. `checkout-api` is a reserved fixture identity. A valid key authorizes submission under other service names within this **single local workspace**; keys are not yet scoped per service or tenant.

An accepted batch is redacted and committed to SQLite before HTTP 202. Its UUIDs provide idempotency: resubmitting identical normalized content is acknowledged without double-counting, while conflicting content returns 409 and rolls back the whole batch. A background worker uses 30-second leases, performs event insertion and job acknowledgment in one transaction, and retries processing errors with exponential backoff up to five attempts before dead-lettering. Stale lease holders cannot commit. Queued work and abandoned leases survive collector restart.

The pending collector queue is capped at 10,000 entries; overflow returns 429. Completed job IDs and telemetry are retained indefinitely in this prototype so retries remain deduplicated. Retention policies and a dead-letter inspection/retry UI remain future work. The development launcher runs an independent worker process. Collector-only startup still embeds a worker unless `INCIDENTLAB_WORKER_MODE=external` is set. The SDK's bounded client-side buffer is **in memory**, so an application crash can lose events that have not received collector acknowledgment.

## PostgreSQL and independent workers (v0.3)

### One-command local development

```powershell
npm.cmd ci
npm.cmd run dev:postgres
```

This starts a real, development-only PostgreSQL server on loopback port **54329**, applies migrations, and launches the collector, ingestion worker and sample service as separate processes. Then run `npm.cmd run sample:traffic` in another terminal. The dashboard queue footer identifies `postgres` storage and `external` worker mode.

The PostgreSQL cluster and generated database password stay in ignored `data/postgres/` and `data/postgres-local.json`. They are not printed or committed. Ctrl+C requests application shutdown before stopping the database; the cluster persists for the next launch. On Windows the embedded package stops PostgreSQL using process termination, so the next launch can perform normal crash recovery. Use a managed PostgreSQL service or normal PostgreSQL installation for durable deployments. `PG_DEV_PORT`, `PORT` and `SAMPLE_PORT` override local ports. No Docker installation is required for this development command. The embedded package is a devDependency; deployments install only `pg` and its dependencies.

SQLite and PostgreSQL use separate databases. Selecting PostgreSQL does **not** import existing SQLite events or replay history. Return to `npm.cmd run dev` without `DATABASE_URL` to access SQLite data. A cross-database importer is outside this milestone.

### Existing PostgreSQL server

Export a PostgreSQL connection string using your shell or secret manager, then run:

```powershell
# Set DATABASE_URL to your database connection string before these commands.
npm.cmd run db:migrate
$env:INCIDENTLAB_WORKER_MODE='external'
npm.cmd start
```

In a second terminal with the **same DATABASE_URL**:

```powershell
npm.cmd run worker
```

Both roles use the same storage contract. `npm.cmd run dev` also respects `DATABASE_URL`, but migrations must already be applied. Connection strings are never sent to the browser. Configure database TLS through your PostgreSQL connection settings for remote deployments; the application does not disable certificate verification.

### Schema and queue guarantees

`db:migrate` runs ordered SQL files inside a transaction guarded by a PostgreSQL advisory lock. A `schema_migrations` table records each file's SHA-256 checksum. Concurrent migration commands serialize. Modified, missing, or out-of-order historical migrations are rejected; failed pending migrations roll back their DDL and history records together. Add new numbered migrations instead of modifying applied files. The runtime requires an already migrated PostgreSQL schema and does not silently create it at startup. These are forward migrations; there is no automatic down-migration or destructive reset command.

PostgreSQL workers atomically claim rows with `FOR UPDATE SKIP LOCKED`. Multiple workers can process independent jobs without waiting for a row held by another worker. An event insert and its queue acknowledgment share one transaction, and attempt/lease checks fence stale workers. Concurrent producers serialize queue-cap checks and whole-batch deduplication; duplicate event insertion is protected independently. The same retries and 30-second lease recovery used by SQLite remain in effect.

`npm.cmd run worker` also supports SQLite using the shared file (optionally `SQLITE_PATH`), with a five-second busy timeout. PostgreSQL is the intended path for multiple workers; SQLite still has one writer at a time. The external-worker dashboard receives refresh notifications every two seconds. A displayed `external` mode describes collector configuration, not a worker health assertion; queued counts reveal waiting work. `/healthz` checks database connectivity, not worker health.

### Docker Compose

`Dockerfile` and `compose.yml` define PostgreSQL 17, a one-shot migration job, collector and independent worker. Set random **URI-safe** `POSTGRES_PASSWORD` and `INCIDENTLAB_INGESTION_KEY` values using your shell or a local ignored `.env`, then run `docker compose up --build`. The collector is published only on `127.0.0.1:4317`; PostgreSQL has no host-published port. The Node image installs production dependencies and runs as a non-root user. Add workers with `docker compose up --scale worker=2`. Compose is optional and was not run locally because Docker is not installed.

This remains a local deployment template: the dashboard has no user authentication, and it should not be exposed publicly. The compose ingestion key must contain at least 24 characters. Back up the PostgreSQL volume before schema changes and do not delete it to perform routine upgrades.

### Database verification

```powershell
npm.cmd test              # SQLite/SDK regression suite; PostgreSQL suite skipped without TEST_DATABASE_URL
npm.cmd run test:postgres # starts an isolated real PostgreSQL cluster when no TEST_DATABASE_URL is provided
```

Alternatively set `TEST_DATABASE_URL` to an existing **test** database. The suite creates and removes a uniquely named schema, leaving other schemas and databases intact. It verifies concurrent/checksummed migrations, failed-DDL rollback, the storage contract, parallel workers, locked-row skipping, retry/lease fencing, atomic acknowledgment, HTTP replay, and a separately launched worker with graceful shutdown. The default suite runs test files serially to keep memory use modest on development machines.

### CI

`.github/workflows/test.yml` runs the SQLite/SDK suite on Windows and Ubuntu with Node 22 and 24. Separate Ubuntu jobs test real PostgreSQL 17 and 18 service containers. CI installs locked production dependencies and needs no account secrets. It runs for main-branch pushes and pull requests.

## Boundaries

This is a single-user **local prototype**, bound to `127.0.0.1`. Do not expose it publicly. The ingestion API uses a bearer key; dashboard reads and fixture controls have no user authentication or multi-tenant isolation. Mutation requests with a foreign Origin are rejected; this is not a substitute for production authentication. SDK payloads are explicitly opted in and redacted, but redaction is not a guarantee against every sensitive value. Replay cannot contact arbitrary URLs or charge a real payment provider.

The built-in investigation notes are deterministic fixture documentation. Optional AI output is labeled separately and is never used to resolve an incident or execute commands. External SDK telemetry uses a durable local ingestion queue; distributed tracing and multi-tenant isolation are not implemented. A replay with no server errors verifies only the captured built-in fixture cases. External replay is unavailable until an isolated adapter is implemented.

## Evidence-based AI investigation (v0.4)

Analysis is **disabled by default** and needs a separately configured server-side OpenAI API key. This project does not use a ChatGPT subscription, search for keys on disk, or silently fall back to invented model results.

```powershell
# Set OPENAI_API_KEY securely in this shell or through your secret manager.
$env:INCIDENTLAB_AI_ENABLED='1'
$env:INCIDENTLAB_AI_MAX_USD='0.02'
$env:INCIDENTLAB_AI_DAILY_USD='1'
npm.cmd run dev:postgres
```

The development launcher passes the provider key only to the collector, not to the worker or sample-service child. Existing PostgreSQL deployments must run `npm.cmd run db:migrate` for `003_incident_analysis.sql` before using analysis. The PostgreSQL dev command applies this automatically. SQLite creates the additive analysis table on opening the existing file. `.env.example` is documentation; direct Node commands do not load it automatically. Docker Compose can consume a local ignored `.env`.

Open an incident and click **Analyze incident**. The page explains that a limited snapshot will be sent to OpenAI. It displays a summary, tentative causes, validation suggestions, next steps, missing evidence and links to the saved evidence rows. The snapshot includes at most twelve captured failures: method, route template, HTTP status, duration and sanitized error class. Request bodies, SDK attributes, headers, raw exception messages and real event IDs are excluded from the provider request. Query strings, recognizable credential strings, long numeric route identifiers and UUID route identifiers are redacted. Applications must still submit route templates: redaction cannot recognize every personal name or arbitrary sensitive path segment.

The provider request uses the pinned `gpt-4.1-mini-2025-04-14` model and strict JSON-schema output through the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/structured-outputs), with no tools, no conversation history, no automatic retries, `store: false`, a 30-second timeout and a maximum of 1,800 output tokens. `store: false` requests no stored Response object; it is not a promise about all provider retention. The model can use only low/medium confidence labels, and the application validates every citation against supplied evidence IDs before displaying the result. Invented references, invalid shapes, refusals and incomplete responses are saved as failures. Citation validity checks that a referenced event exists, not that a causal claim is true. Suggestions are displayed as escaped text and never executed.

### Cache, retries and estimated budgets

Successful results and their exact evidence snapshots persist in either database. Opening or refreshing an incident only reads saved data. The cache key includes the incident, evidence hash, model and prompt version; new captured failures produce a new snapshot and mark older saved results stale. Concurrent collectors share a transactional reservation, so duplicate clicks cannot initiate two provider requests for the same attempt. An explicit failed-request retry is capped at three attempts per snapshot. Pending requests older than 90 seconds become interrupted failures when the analysis endpoint is next accessed. Interrupted or uncertain requests are never automatically retried, and late completions cannot overwrite an expired reservation.

The defaults are an **estimated $0.02 per-request limit** and **$1 UTC daily reservation budget**, shared by all collectors using the same database. The app reserves a conservative estimate before the request using bounded UTF-8 input size plus overhead, the output-token cap, and standard model rates of $0.40 input / $1.60 output per million tokens, checked against the [official model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini) on 2026-11-16. It also saves provider-reported token usage and estimated usage cost. Reservations remain fully counted after success, failure or timeout; they are not refunds or exact billed spend. If reported estimated usage is higher, the ledger counts the larger amount. Pricing, token accounting and other use of the same key can affect actual bills; use provider-side spending controls for account-wide limits. No paid provider call is required by any automated test.

Per-request configuration must be positive and no more than $1; daily configuration must be positive and no more than $10. Invalid configuration disables analysis. Insufficient per-request or shared daily budget rejects the request before contacting the provider. Changes to budget limits do not erase prior reservations. Paid-analysis POSTs accept only loopback dashboard hostnames and reject foreign browser origins. This is still a local, single-user app with no production authentication.

Tests use mocked provider responses to validate request structure, redaction, budget enforcement, cache/staleness, concurrency, persistence, retry limits, refusal/incomplete handling, citation rejection and the HTTP flow. Real PostgreSQL integration tests additionally exercise shared reservations and cached results across separate database pools. A live provider/model-quality check requires an explicitly configured key and is not part of CI.

## Next milestones

- [x] Separate sample service plus an ingestion SDK with payload redaction and authenticated ingestion.
- [x] Durable SQLite ingestion queue, retries, idempotency, lease recovery and compatibility migration.
- [x] CI matrix covering Windows/Ubuntu and Node 22/24 (workflow configured; hosted results depend on GitHub Actions).
- [x] PostgreSQL storage adapter, versioned SQL migrations and independently running workers.
- [x] Optional evidence-based AI analysis, citation checks, saved results, uncertainty and estimated budget limits.
- [ ] Isolated replay workers, controlled fault injection, and comparable latency measurements.
- [ ] Dashboard authentication, workspaces, deployment, load tests, and a measured public demo.

## Portfolio evidence

Record a short failure-to-resolution demo and publish the test output and architecture tradeoffs. Add throughput or latency claims to your résumé only after measuring them. This first milestone proves incident grouping, persisted evidence, recurrence handling, and controlled request replay.
