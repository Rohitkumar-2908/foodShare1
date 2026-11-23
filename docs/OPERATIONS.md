# Operations

## First start
Full step-by-step with troubleshooting: docs/ACCOUNTS.md. If you cannot sign in as admin, run `npm run admin`.
Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `DATA_KEY` (see `.env.example`). On the first start the admin account is created if no admin exists. Sign in at `/#login-admin`, open Users, and use **Add a quality inspector** (gives a one-time setup code) or **Reset password** (gives a reset code) for anyone who is locked out. Turn on two-factor authentication for the admin under Profile.

## Run with Docker (not tested in the build environment)
```bash
cp secrets/mongodb_uri.txt.example secrets/mongodb_uri.txt         # then edit the values
cp secrets/metrics_token.txt.example secrets/metrics_token.txt
cp secrets/mongo_root_password.txt.example secrets/mongo_root_password.txt
cp secrets/data_key.txt.example secrets/data_key.txt            # replace with: openssl rand -hex 32
cp secrets/admin_password.txt.example secrets/admin_password.txt
export ADMIN_EMAIL=you@example.org
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" -keyout certs/privkey.pem -out certs/fullchain.pem   # dev certificate only
docker compose up --build        # https://localhost:8443
```
Use a real certificate (Let's Encrypt) in production.

## Health, monitoring, alerting
* `/healthz` = process alive. `/readyz` = ready for traffic (503 while draining). Point Docker, nginx and an external uptime monitor at `/readyz`.
* `/metrics` (Prometheus): request counts and latency histogram, queue depth, dead-letter jobs, circuit state, memory. Alert rules: `ops/alerts.yml`. A circuit-open event also sends an `alert.circuit_open` webhook.
* Logs are JSON lines with `requestId` and `traceId` (W3C `traceparent` accepted and echoed).

## Backups and disaster recovery
* Snapshot every `BACKUP_INTERVAL_MIN` minutes to `data/backups` (newest `BACKUP_KEEP` kept). Copy the folder off the machine and encrypt it.
* Restore: stop the app, `npm run restore -- <file>`, start the app. Test this regularly.
* Suggested targets: RPO 1 hour, RTO 30 minutes. Atlas users should also enable Atlas backups.

## Release process
Trunk-based: short-lived branches, pull request, one review (CODEOWNERS), CI must pass (tests, `npm audit`, Docker build + smoke test), merge to `main`, tag `vMAJOR.MINOR.PATCH`. Deploy to staging first (same compose file, different secrets), then production. The deploy job in CI is a stub.

## Feature flags, debugging, profiling
`FEATURES=webhooks,metrics,readOnly`; `readOnly` makes writes return 503 (maintenance). `GET /api/v1/flags` lists them. `npm run profile` writes a CPU profile to `./profiles`. Every error response has a `requestId` that matches a log line.
