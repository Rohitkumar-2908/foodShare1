# Changelog (semantic versioning: MAJOR.MINOR.PATCH)

## 3.3.0 (Maps)
- Real interactive street map (Leaflet 1.9.4 + light CARTO Positron tiles) replaces the schematic SVG in the food finder (tap a pin to filter), dashboard overview, and distributor route (dashed route lines). Pins are sized by meals, keyboard accessible, and popups link to Google Maps.
- Automatic fallback to the old schematic if Leaflet or the tiles cannot load.
- CSP widened minimally: tiles `https://*.basemaps.cartocdn.com` (img-src) and Leaflet CSS from cdnjs (style-src). `connect-src` stays `'self'`.
- 10 new tests (map.test.js).

## 3.2.0 (Vercel)
- Vercel support: `api/index.js` serverless handler, `vercel.json` (static `public/`, rewrites, security headers), `.vercelignore`, `docs/VERCEL.md`.
- Serverless mode (auto when `VERCEL=1`): MongoDB only (no disk fallback), no state cache between requests, proxy headers trusted, queue flushed before each response, lazy housekeeping, small connection pool.
- Missing `MONGODB_URI`/`DATA_KEY` no longer breaks the page: health reports `auth:false` and the page uses its browser-only demo mode; other API calls return a clear 503.
- Database outages return 503 `db_unavailable` instead of 500.
- `mongodb` is now a regular dependency; Node pinned to 22.x; CI runs on Node 22.
- 11 new tests (73 total), including a Vercel routing emulator.

## 3.1.1
- Added `npm run admin` to create the admin or reset its password (works when an old admin already exists).
- The server now prints clearly whether the admin was created, ignored or rejected (and why), warns when no `.env` file is found, and the admin sign-in page explains what to do.
- `.env` parsing accepts `export`, lowercase names, quotes and Windows line endings.
- docs/ACCOUNTS.md: step-by-step admin, inspector and one-time-code guide.
- Tests: 62.

## 3.1.0
- Home page: rotating 3D photo ring (drag, arrows, click to zoom) using the supplied photos, smaller statistic tiles, and a terms and conditions section.
- New public pages: About, How it works, Gallery (zoomable), Terms.
- Dashboards: every role now has Overview (greeting, key numbers, recent activity, map, extra card) and Help; plus Map (donor, NGO, organiser), Route map with a one-click Google Maps route (distributor), and Safety guide (inspector).
- Admin: compact header chip, no forced profile step.
- Fixed: avatar skin colour could be missing for some names.
- Fixed: a retried background job could be left waiting forever when its timer fired a millisecond early.
- Tests: 54.

## 3.0.0
- BREAKING: whole-state access (`/api/v1/state`) removed (returns 410). The frontend now uses `/api/v1/auth/*`, `/api/v1/view` and `/api/v1/actions/*`.
- Added: server-side accounts (scrypt), cookie sessions, CSRF protection, lockout, TOTP two-factor authentication with recovery codes, admin-issued reset codes, role and ownership checks on every action, per-role data views, verified-account gate, pickup-code lockout, soft deletes, account export and erase, encrypted 2FA secrets, admin created from environment settings.
- Tests: 52 (unit, HTTP, security, frontend against server).

## 2.0.0
- BREAKING: API moved to `/api/v1`; old `/api/state` now returns 410. `PUT` requires `If-Match` (revision) and a JSON content type.
- Added: circuit breaker + file fallback + reconcile, optimistic concurrency, idempotency keys, rate limiting, request IDs and trace headers, structured logs, Prometheus metrics, health/readiness, graceful shutdown, queue with retries, signed webhooks, scheduled backups, data migrations, feature flags.
- Added: Docker, docker-compose, nginx, CI workflow, alert rules.
- Frontend: spatial, neumorphic and glass styling; resilient sync with timeouts and backoff; data export and account deletion.

## 1.0.0
- Single-file frontend, simple state sync.
