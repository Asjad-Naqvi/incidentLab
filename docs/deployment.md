# Free hosted demo and deployment operations

## Two separate modes

| Mode | Entry point | Storage and access |
| --- | --- | --- |
| Owner workspace | `node server.mjs` / `compose.yml` | Authenticated, persistent SQLite or PostgreSQL. Real SDK ingestion and independent workers. |
| Public demo | `node demo-server.mjs` / `compose.demo.yml` | A dedicated in-memory SQLite database per browser session. Sample fixture only. No owner credentials or real telemetry. |

The demo deliberately ignores `DATABASE_URL` and ingestion credentials. Do not configure those on Render. It is a single-process portfolio sandbox, not a replacement for the persistent owner deployment. Browsers sharing the same cookie share a sandbox; use an incognito window for a second visitor.

## Run the hosted-demo build locally

```powershell
cd "D:\Codex\Projects\incidentlab"
docker compose -p incidentlab-demo-preview -f compose.demo.yml up -d --build --wait
```

Open http://127.0.0.1:4318 and choose **Start my demo**. This can run beside the owner stack on port 4317. The local demo container has a read-only root filesystem, no database volume, no extra Linux capabilities, no-new-privileges, a 512 MB memory cap and a half-CPU limit. Render's free service uses its platform resource limits instead; Compose restrictions are not automatically applied by Render.

```powershell
# Inspect or stop only the demo; the owner stack is unaffected.
docker compose -p incidentlab-demo-preview -f compose.demo.yml logs --tail 50
docker compose -p incidentlab-demo-preview -f compose.demo.yml down
```

Without Docker: `npm.cmd run demo` starts the same demo on loopback port 4318.

## Publish on Render for $0

Checked against Render documentation on 2026-11-17. Use one **Free web service**. No paid disk, database, worker, custom domain, or model API is needed. Free services sleep after 15 minutes without inbound traffic, and waking can take about a minute. They share 750 free instance-hours per workspace each month. Data resets on sleep, restart, and redeploy. Limits can change: check the [current free plan](https://render.com/docs/free) before creating the service.

1. Sign up at https://dashboard.render.com and connect GitHub. Grant Render access to the private `Asjad-Naqvi/incidentLab` repository; the repository does not need to be made public.
2. After this feature is merged to `main`, choose **New → Blueprint**, select the repository and `main`, and use the included `render.yaml`.
3. Review the resources: it must show only **incidentlab-demo**, a **Free** web service. The Blueprint does not provision a database or paid resources. Create it after confirming the free plan. If signup requires payment details you do not want to supply, stop; local Docker remains available.
4. Wait for the deploy to become live. Open the `https://...onrender.com` URL shown by Render.
5. Open `/healthz`: expect `{"status":"ok","mode":"demo"}`. Check the workflow below in two separate browser profiles.

The Blueprint runs `node --max-old-space-size=256 demo-server.mjs`, binds to `0.0.0.0:$PORT`, and waits for passing GitHub checks before automatic updates. `RENDER_EXTERNAL_URL` supplies the exact allowed HTTPS origin. Secure `__Host-` cookies and HSTS are enabled. No secrets need to be pasted into the Render environment. For another host or custom domain, set `INCIDENTLAB_PUBLIC_ORIGIN` to the exact HTTPS origin; forwarded headers are not trusted to select an origin.

If using **New → Web Service** manually instead: select the private repository, Docker runtime, branch `main`, Free instance, and health path `/healthz`; set the Docker command above, `NODE_ENV=production`, and `INCIDENTLAB_HOST=0.0.0.0`. Do not use the Dockerfile's default command, which starts the owner application.

Do not add a payment method or upgrade resources for this demo. Render documents suspension rather than bandwidth overage billing when no payment method is present. Review the account's usage and spending settings. Do not add uptime bots to prevent free-tier sleep.

## Public-demo boundaries

- Sessions last 20 minutes, with at most 24 live sandboxes and 20 new starts per minute across the process. Capacity is released on expiry or **End demo**. This bounds resources; it is not an internet-scale anti-bot service.
- Each sandbox allows 120 fixture events, 12 saved replays, 120 routed requests/minute, 20 routed mutations/minute, and two event streams. Limits return a helpful error and `Retry-After` for request throttles.
- State-changing requests require a session-bound CSRF token; session creation requires a same-origin custom-header request. Duplicate or forged cookies are rejected. Cookie IDs are random and only their hashes are retained in memory.
- Only allowlisted fixture and dashboard routes are exposed. Ingestion, password login, owner setup, arbitrary checkout payloads and external adapters are not available. No shared public password is distributed.
- Request logs contain method, status and elapsed time only. They omit paths, request bodies, cookies, IP addresses and credentials. Health checks disclose mode/readiness, not visitor data.
- HTTP/header timeouts and connection caps are applied. Shutdown ends event streams and drains replay work with a ten-second deadline. Security headers include CSP, frame denial, content-type protection, referrer policy and HTTPS HSTS.
- A process restart clears every visitor sandbox. Isolation is implemented in the application using separate databases, not separate operating-system containers per visitor. The public demo executes only the built-in fixture and never accepts code or target URLs.

## Release smoke check / portfolio walkthrough

1. Open the public URL and start a sandbox. Confirm it begins empty.
2. **Generate demo traffic**: 12 requests, four server failures, one grouped incident.
3. Open the incident and **Replay captured requests**: four errors reproduce.
4. **Apply demo fix**, replay again: zero server errors; expired sessions return a handled 409, not a completed purchase.
5. **Mark resolved**. Open **Replay history** to compare evidence. Replays must not inflate the 12 captured requests.
6. In an incognito window, start a second sandbox: its request count is zero and the bug is still enabled.
7. **End demo** in the first browser. Start again: its data is empty.
8. Confirm `/api/v1/events` is unavailable. No owner login or external integration instructions should be offered in demo mode.

A 60–90 second portfolio recording can follow steps 1–5. Describe this as a synthetic checkout fixture with real captured/replayed execution, and distinguish it from production traffic or AI-generated analysis. Screenshots are stored in `docs/images/` when captured during release validation.

## Owner deployment, backups and recovery

The free public demo needs no backups. For the persistent owner workspace, retain PostgreSQL's named volume and keep `.env` stable. Configure HTTPS at your reverse proxy, set the exact `INCIDENTLAB_PUBLIC_ORIGIN`, and set `INCIDENTLAB_COOKIE_SECURE=1`. Never expose the owner application as the public demo.

For coordinated restarts, run `docker compose down` then `docker compose up -d --wait`. Do not restart all roles simultaneously: plain `restart` does not wait for database readiness. Do not use `down --volumes` for routine maintenance. Back up before applying migrations, and validate recovery on a separate database.

Create a backup from PowerShell in the project folder (the fixed filename is overwritten on each run, so archive it privately with a date afterward):

```powershell
New-Item -ItemType Directory -Path backups -Force
# Produce the binary archive inside the container to avoid PowerShell 5.1 redirection encoding issues.
docker compose exec -T postgres pg_dump -U incidentlab -d incidentlab --format=custom --no-owner --no-acl --file=/tmp/incidentlab.backup
docker compose cp postgres:/tmp/incidentlab.backup ./backups/incidentlab.backup
docker compose exec -T postgres rm /tmp/incidentlab.backup
```

Backups include account hashes and telemetry; keep them private. `backups/` is excluded from Git and Docker builds. A PostgreSQL volume alone is not an off-machine backup.

Verify a backup by restoring into a **new, empty** database, never directly over the live one:

```powershell
docker compose cp ./backups/incidentlab.backup postgres:/tmp/incidentlab.backup
docker compose exec -T postgres createdb -U incidentlab incidentlab_restore_check
docker compose exec -T postgres pg_restore -U incidentlab --no-owner --no-acl --exit-on-error -d incidentlab_restore_check /tmp/incidentlab.backup
docker compose exec -T postgres psql -U incidentlab -d incidentlab_restore_check -c "SELECT COUNT(*) FROM schema_migrations; SELECT COUNT(*) FROM incidents;"
docker compose exec -T postgres rm /tmp/incidentlab.backup
```

If the verification database already exists, choose a new name instead of overwriting it. Recover by stopping collector/worker and configuring them and owner setup to use the verified restored database; retain the original until recovery is confirmed. Revoke sessions through password recovery before exposing a restored owner workspace. Replay tests are not a substitute for a backup restore drill.

## Measurement and remaining release gate

`npm.cmd run benchmark` uses only a disposable in-memory SQLite database and loopback HTTP. It measures serial 25-event batch acceptance and draining a deliberately paused queue. It neither sends load to Render nor estimates production/PostgreSQL throughput. See `benchmark-local.json` for the recorded run and its scope.

Local tests and Docker checks are release evidence. The milestone is only publicly live after the account owner creates the Free Render service and the public URL passes the smoke check. Do not advertise a deployment URL before verifying it.

## Recorded validation for v0.7

- Windows Node 22 regression suite: 42 passed, one PostgreSQL-only suite skipped.
- Real PostgreSQL integration suite: all 13 scenarios passed.
- Read-only, 512 MB / half-CPU Docker demo: all seven adversarial and lifecycle tests passed.
- Headless Chrome: landing, session creation, traffic, failed replay, fix, successful replay, resolution, and mobile layout passed.
- PostgreSQL `pg_dump`/`pg_restore` drill: four migrations, one owner, and one incident recovered into a new database. Disposable resources were removed.
- Free Render public URL: pending account connection and deployment.
