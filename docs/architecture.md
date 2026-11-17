# Architecture and trust boundaries

IncidentLab has two entry points sharing the same fixture, storage contract, incident grouping and replay verification logic.

## Persistent owner workspace

The browser authenticates with a revocable owner session and a CSRF token. The collector accepts telemetry only with a separate ingestion bearer key, validates/redacts events, and writes a durable ingestion job. An independent worker claims jobs with lease fencing and writes captured events/incidents. SQLite supports local development; PostgreSQL supports separate processes and multiple workers. Migrations precede application startup in Compose.

Replaying an incident never fetches a captured URL. The built-in checkout fixture re-executes allowlisted fixture inputs. External sample replay uses the trusted sample adapter in a worker thread; it is not an operating-system sandbox for arbitrary customer code. Successful replay evidence is required before resolving the built-in fixture incident.

## Free public demo

The public browser opens a landing page and explicitly creates a random-cookie session. A gateway verifies host/origin, CSRF, route allowlists, quotas and expiry before forwarding a request to that visitor's application instance. Each instance has its own in-memory SQLite database, fixture settings, replay history and event streams. The existing app runs behind this gateway without owner-password authentication; it is never directly bound to a network port.

| Boundary | Enforcement |
| --- | --- |
| Visitor A / visitor B | Independent random sessions and separate databases; incident IDs from another visitor return 404 |
| Public demo / owner data | Separate entry point; no `openStore()` or `DATABASE_URL` usage in demo startup |
| Browser / mutations | Session-bound CSRF token, exact configured origin, host validation, Strict HttpOnly cookies |
| Internet / internal app | Explicit route allowlist; no ingestion, owner login, arbitrary payloads or target URLs |
| Resource usage | Session TTL/capacity, starts/minute, per-session request and data quotas, stream cap, HTTP timeouts and connection cap |
| Platform / transport | Render provides TLS; app uses HTTPS origin, secure host cookies, CSP and HSTS |
| Process shutdown / data | Streams ended and active replay work drained within a deadline; all demo state is intentionally discarded |

A single Render Free web service runs the whole public demo. There is no persistent disk, external database, AI provider or separate paid worker. It sleeps when idle. Scaling to multiple instances would require shared session routing/storage and is outside this design.

## Evidence and limitations

- Integration tests execute the actual HTTP routes, including cross-session access attempts and replay verification.
- Docker tests use a read-only, memory-limited, non-root container.
- Browser validation follows the landing → traffic → replay → fix → replay → resolution workflow at desktop and mobile sizes.
- `docs/benchmark-local.json` records a narrowly scoped local SQLite ingestion/paused-worker measurement. It is not a production SLO or a Render capacity estimate.
- Resource caps reduce accidental abuse. They do not provide internet-scale DDoS protection or guaranteed availability on free hosting.
- Visitor isolation is application-level. Untrusted code execution is not supported. Public demo state is neither permanent nor backed up.
