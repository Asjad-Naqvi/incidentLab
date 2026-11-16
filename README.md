# IncidentLab

A local incident investigation platform: capture a service failure, inspect its evidence, replay captured requests, and measure what changes after a fix.

## Run

Requires **Node.js 22.14 or later**. No account, GPU, or model API key is required. Install dependencies once:

```powershell
cd incidentlab
npm.cmd ci
npm.cmd run auth:setup
npm.cmd start
```

Open **http://127.0.0.1:4317** and sign in with the workspace owner created by `auth:setup`. Password entry is hidden; no default owner or password is provided. On Windows, `npm.cmd` avoids PowerShell execution-policy restrictions on `npm.ps1`. PostgreSQL setup differs as described below.

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
- `sample/checkout.mjs`: trusted sample handler shared by the HTTP service and replay adapter.
- `lib/isolated-replay.mjs`: bounded worker-thread replay lifecycle and persisted outcomes.
- `lib/replay-thread.mjs`: paired baseline/candidate execution without ingestion or database clients.
- `lib/replay-contract.mjs`: explicit service, route, fixture and sample-size validation.
- `sdk/`: installable local Node SDK with payload opt-in, redaction, bounded buffering and retries.
- `sample/server.mjs`: independently running checkout HTTP service, instrumented through the SDK.
- `lib/worker.mjs`: background ingestion processing, retry backoff and lease recovery.
- `worker.mjs`: independently deployable ingestion-worker entry point.
- `lib/open-store.mjs`: selects PostgreSQL using `DATABASE_URL`, otherwise SQLite.
- `lib/postgres-store.mjs`: asynchronous PostgreSQL storage adapter and transactional queue operations.
- `migrations/postgres/`: ordered SQL migrations with a checksum-verified migration history.
- `public/`: responsive, accessible dashboard with search, status filters, an investigation drawer, and replay history.
- `test/`: end-to-end HTTP workflow, recurrence, input handling, and durable-storage checks.

Only original captured traffic contributes to live metrics. Replays are stored separately. p95 is measured across all captured live requests; the activity chart shows the last hour in two-minute buckets. Incident request lists show the newest twenty failures and replay tables the first ten results. The original built-in replay executes up to one hundred failures; the isolated external sample adapter uses at most twenty.

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
| POST | `/api/incidents/:id/replay` | Built-in replay, or isolated sample comparison with `{ "revision": "baseline" }` / `{ "revision": "candidate" }` |
| POST | `/api/incidents/:id/resolve` | Resolve after successful fixed replay evidence |
| POST | `/api/v1/events` | Authenticated, validated telemetry batch; returns 202 after durable enqueue |
| GET | `/healthz` | Collector liveness |
| GET | `/api/auth/status` | Public setup/session status; authenticated clients receive a CSRF token |
| POST | `/api/auth/login` | Sign in with owner username and password; sets an HttpOnly session cookie |
| POST | `/api/auth/logout` | Revoke the current session; requires session cookie and CSRF token |

Dashboard reads, live updates, replay, resolution and fixture controls require an owner session. Their POST requests also require `X-CSRF-Token` from the session-status endpoint. `/healthz` and login assets remain public. The ingestion endpoint uses its own bearer key and does not accept a browser session as authorization.

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

This starts a real, development-only PostgreSQL server on loopback port **54329**, applies migrations, and launches the collector, ingestion worker and sample service as separate processes. On first launch, run `npm.cmd run auth:setup -- --local-postgres` in another terminal while the database is running, then sign in. Run `npm.cmd run sample:traffic` to generate events. The dashboard queue footer identifies `postgres` storage and `external` worker mode.

The PostgreSQL cluster and generated database password stay in ignored `data/postgres/` and `data/postgres-local.json`. They are not printed or committed. Ctrl+C requests application shutdown before stopping the database; the cluster persists for the next launch. On Windows the embedded package stops PostgreSQL using process termination, so the next launch can perform normal crash recovery. Use a managed PostgreSQL service or normal PostgreSQL installation for durable deployments. `PG_DEV_PORT`, `PORT` and `SAMPLE_PORT` override local ports. No Docker installation is required for this development command. The embedded package is a devDependency; deployments install only `pg` and its dependencies.

SQLite and PostgreSQL use separate databases. Selecting PostgreSQL does **not** import existing SQLite events or replay history. Return to `npm.cmd run dev` without `DATABASE_URL` to access SQLite data. A cross-database importer is outside this milestone.

### Existing PostgreSQL server

Export a PostgreSQL connection string using your shell or secret manager, then run:

```powershell
# Set DATABASE_URL to your database connection string before these commands.
npm.cmd run db:migrate
npm.cmd run auth:setup
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

This remains a local deployment template. After startup, initialize the owner with `docker compose exec collector npm run auth:setup` in an interactive terminal. The compose ingestion key must contain at least 24 characters. Back up the PostgreSQL volume before schema changes and do not delete it to perform routine upgrades. Configure an HTTPS reverse proxy and the exact public origin before any non-local deployment; owner login alone does not make this a hardened multi-user service.

### Database verification

```powershell
npm.cmd test              # SQLite/SDK regression suite; PostgreSQL suite skipped without TEST_DATABASE_URL
npm.cmd run test:postgres # starts an isolated real PostgreSQL cluster when no TEST_DATABASE_URL is provided
```

Alternatively set `TEST_DATABASE_URL` to an existing **test** database. The suite creates and removes a uniquely named schema, leaving other schemas and databases intact. It verifies concurrent/checksummed migrations, failed-DDL rollback, the storage contract, parallel workers, locked-row skipping, retry/lease fencing, atomic acknowledgment, HTTP replay, and a separately launched worker with graceful shutdown. The default suite runs test files serially to keep memory use modest on development machines.

### CI

`.github/workflows/test.yml` runs the SQLite/SDK suite on Windows and Ubuntu with Node 22 and 24. Separate Ubuntu jobs test real PostgreSQL 17 and 18 service containers. CI installs locked production dependencies and needs no account secrets. It runs for main-branch pushes and pull requests.

## Boundaries

This is a single-workspace **local prototype**, bound to `127.0.0.1`. Owner sign-in protects the dashboard and controls; ingestion uses a separate bearer key. Multi-user invitations, workspace isolation and production deployment hardening are not implemented. SDK payloads are explicitly opted in and redacted, but redaction is not a guarantee against every sensitive value. Replay cannot contact arbitrary URLs or charge a real payment provider.

The built-in investigation explanation is deterministic fixture documentation, **not AI output**. External SDK telemetry uses a durable local ingestion queue; distributed tracing and multi-tenant isolation are not implemented. External replay supports only the bundled checkout sample through the adapter described below. Other services require explicit, trusted adapters.

## Isolated sample replay and fault injection (v0.5)

This milestone works without any model API or key. The optional AI work remains separate in PR #3.

1. Run `npm.cmd run dev` for SQLite, or `npm.cmd run dev:postgres` for PostgreSQL.
2. In another terminal, run `npm.cmd run sample:traffic -- --slow`.
3. Open the `checkout-sample` / `PaymentSessionExpired` incident.
4. Click **Replay baseline** to reproduce failures in an isolated copy of the sample implementation.
5. Click **Test candidate fix** to compare baseline handling against the bundled candidate, which handles session expiry before the simulated slow dependency.
6. Inspect paired error rates, p50/p95/mean latency in saved replay data, implementation hash, reproduction counts, and per-request results. Replay history includes completed and failed attempts.

`--slow` injects a controlled `slow-expired-session` fixture into four of twelve sample requests. The broken sample waits approximately 98 ms and returns 500. Its candidate handles expiry in approximately 18 ms and returns a recoverable 409. Without `--slow`, the existing normal session-expiry fixture continues to work. These delays are artificial, measured with the runtime clock, and subject to machine load; do not present them as production performance claims.

### Isolation boundary and comparisons

The server validates the exact service (`checkout-sample`), error class (`PaymentSessionExpired`), method (`POST`), route (`/checkout`), captured status (500), and fixture enum before copying at most twenty requests to a fresh Node worker thread. Arbitrary target URLs, source code, headers and extra payload fields are not forwarded. The worker receives an empty environment, no inherited Node execution flags, a 32 MB old-generation heap limit, an 8 MB young-generation limit, a 2 MB stack limit, and a ten-second wall-clock deadline. Node heap limits do not cap every native/external allocation; this is a trusted static adapter, not a way to execute untrusted code.

A worker thread has separate JavaScript state but is **not an OS security sandbox**: the code runs within the collector process with normal Node capabilities. The bundled adapter performs no network requests and has no database or SDK client. It loads only the trusted sample handler, executes both revisions in fresh paired measurements, alternates their order, and reports results back. No captured URL is contacted. The implementation hash identifies the actual loaded checkout function. Captured historical timings are preserved for reference, but the comparison metrics use freshly measured baseline and comparison calls in the same worker.

The candidate is a bundled simulation of a patch, not an uploaded diff or a deployment. A pass requires reproducing every selected captured failure in the baseline and observing no candidate server errors. A 409 still means the purchase did not complete. A passed adapter comparison never resolves a live external incident, changes its sample process, or proves that a production fix was deployed. The original built-in fixture's verified-resolution workflow is unchanged.

### Lifecycle and persistence

The collector allows one fixture/replay operation at a time; another request gets 409. This limit is per collector instance, not a distributed quota. Worker timeout, crash, and graceful cancellation save failed replay records with no successful verification. The collector waits for replay cancellation/persistence during graceful shutdown. A whole collector crash can lose an in-flight attempt; there is no durable replay-job queue in this milestone. Successful and failed replay outcomes use the existing JSON replay records in SQLite/PostgreSQL, so no new database migration is needed.

Replay traffic does not enter ingestion, create incidents, or affect live request/error/latency metrics. UI tables show up to ten paired results while persisted records retain the selected request set. Tests cover contract rejection, input minimization, deadline/crash handling, cancellation, concurrency, baseline reproduction, candidate behavior, live-service isolation, history rendering helpers, and PostgreSQL persistence. The embedded Windows test database uses synchronous I/O to avoid orphaned asynchronous-I/O workers during test cleanup; normal PostgreSQL deployment settings are unchanged.

## Owner authentication (v0.6)

The existing workspace has one local owner. There is no public registration, seeded account, default password, OAuth connection or email service. Initialize the account from an interactive terminal:

```powershell
# SQLite: uses the default database, or the configured SQLITE_PATH.
npm.cmd run auth:setup

# Bundled PostgreSQL: start dev:postgres first; setup reads its ignored local configuration.
npm.cmd run auth:setup -- --local-postgres
```

Use the same `DATABASE_URL` for setup with a managed PostgreSQL database. Usernames are normalized to lowercase and accept 3–64 letters/numbers/dots/underscores/hyphens. Passwords require 12–128 characters and are entered without terminal echo. Passwords are not accepted as CLI arguments, printed, committed, or stored in plaintext. The implementation uses salted scrypt (`N=32768,r=8,p=3`) and constant-time derived-key comparison, following the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Sign in at `/login`. Each successful login generates a new random 256-bit session token, stored in an HttpOnly, SameSite=Strict cookie. Only its SHA-256 hash is stored in the database. Sessions expire after eight hours or thirty minutes without authenticated requests, and an account can have at most five active sessions. The dashboard keeps CSRF tokens only in page memory; protected POSTs require a session-bound `X-CSRF-Token`. Cross-origin browser mutations are rejected, and the live-update stream is revalidated and closed after logout or expiry. Telemetry bearer keys cannot read the dashboard, and owner sessions cannot authorize telemetry submission.

Failed sign-ins are limited per account (5), socket IP (10) and collector database (100) within a fifteen-minute window; limits are shared across collectors. Successful sign-in clears its counters. The app returns the same invalid-credentials error for unknown users and wrong passwords, computes a dummy password hash for unknown users, and caps concurrent password verification at two operations per collector. Client-supplied forwarding headers are not trusted for IP limits. Deployment behind a proxy requires a separate review of proxy/rate-limit configuration.

Local recovery is deliberately an administrator operation:

```powershell
npm.cmd run auth:password
# For the bundled PostgreSQL database:
npm.cmd run auth:password -- --local-postgres
```

Recovery prompts for the owner username and a new hidden password, then atomically revokes every existing session and clears sign-in throttles. Account-row checks prevent a concurrent login using the old hash from creating a new session after recovery. This command requires direct access to the database through the local machine/configuration; there is no unauthenticated web password-reset endpoint.

For a TLS reverse proxy, set `INCIDENTLAB_PUBLIC_ORIGIN` to the exact HTTPS browser origin. HTTPS configuration enables `Secure` cookies with the `__Host-` prefix; the cookie has no Domain attribute and uses `Path=/`. HTTP public origins are accepted only for loopback hosts. `INCIDENTLAB_COOKIE_SECURE=1` also forces secure cookies, but browsers will not send them over ordinary HTTP. Forwarded headers do not silently change the trusted origin. Local HTTP uses a non-Secure host-only cookie to support loopback development. Session behavior follows the [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

SQLite adds authentication tables without removing existing incidents. PostgreSQL requires `004_owner_auth.sql`. Migration `003_incident_analysis.sql` preserves the exact schema history reserved by the parked AI PR; including that schema does not enable AI features or make model requests. The PostgreSQL dev launcher migrates automatically; existing installations must run `db:migrate`. Old test harnesses explicitly opt out of auth only to test their original handlers; the executable collector always enables authentication and has no environment variable to disable it.

Authentication tests cover access defaults, scrypt, cookie flags, CSRF, logout, expired/forged/duplicate sessions, throttle persistence, local recovery, live-stream revocation and restart persistence. Real PostgreSQL tests cover concurrent bootstrap, cross-collector sessions, shared throttles and authenticated HTTP workflows. The terminal setup command is also smoke-tested with an isolated disposable SQLite account. No real user account is created by automated tests.

Docker availability was checked on this Windows development host: no CLI on PATH, no standard Docker Desktop CLI installation, and no Docker service/backend were found. Docker Compose remains unexecuted locally; CI continues to test PostgreSQL using service containers.

## Next milestones

- [x] Separate sample service plus an ingestion SDK with payload redaction and authenticated ingestion.
- [x] Durable SQLite ingestion queue, retries, idempotency, lease recovery and compatibility migration.
- [x] CI matrix covering Windows/Ubuntu and Node 22/24 (workflow configured; hosted results depend on GitHub Actions).
- [x] PostgreSQL storage adapter, versioned SQL migrations and independently running workers.
- [ ] AI explanations grounded in captured evidence, with explicit uncertainty and cost limits.
- [x] Isolated checkout-sample replay adapter, controlled fault injection, and paired latency measurements.
- [ ] OS-level replay sandbox, durable replay jobs and additional trusted service adapters.
- [x] Owner authentication, session protection, local setup/recovery and shared login throttling.
- [ ] Multi-user workspaces/roles, deployment hardening, load tests, and a measured public demo.

## Portfolio evidence

Record a short failure-to-resolution demo and publish the test output and architecture tradeoffs. Add throughput or latency claims to your résumé only after measuring them. This first milestone proves incident grouping, persisted evidence, recurrence handling, and controlled request replay.
