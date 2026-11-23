<<<<<<< HEAD
# FoodShare 3.3

Food donation platform. Plain JavaScript (no TypeScript). The server uses Node's built-in `http` module, so it has **no runtime dependencies** (only the `mongodb` driver is needed, and the app still runs without it using the local file database).

## Deploy on Vercel
See **[docs/VERCEL.md](docs/VERCEL.md)**: create a free MongoDB Atlas cluster, set `MONGODB_URI`, `DATA_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` in Vercel, deploy. `vercel.json` and `api/index.js` are already set up.

## Run locally / Docker
```bash
npm install            # installs the MongoDB driver
cp .env.example .env
npm start              # http://127.0.0.1:3000
npm test               # 62 tests: unit, HTTP, security and frontend-against-server
npm run backup         # snapshot to data/backups
npm run restore -- data/backups/db-XXXX.json
npm run loadtest -- http://127.0.0.1:3000/api/v1/health 2000 50
```

* **Database:** MongoDB first (set `MONGODB_URI`); if it is missing, unreachable or drops, the server switches to `data/db.json` automatically, reconnects with exponential backoff, and copies newer local data back into MongoDB. The badge at the bottom-left of the page shows which is active.
* **Maps:** real street maps (Leaflet with light/white CARTO tiles, OpenStreetMap data) in the food finder, the dashboard overview and the distributor route. No API key needed. If the map library or tiles cannot load, the page falls back to the simple schematic map, so nothing breaks.
* **Frontend:** `public/index.html` (single file). Without the server it keeps everything in browser local storage.
* **Docs:** [ACCOUNTS](docs/ACCOUNTS.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [SECURITY](docs/SECURITY.md) · [OPERATIONS](docs/OPERATIONS.md) · [CHECKLIST (what is and is not built)](docs/CHECKLIST.md) · [OpenAPI](docs/openapi.yaml) · [CHANGELOG](CHANGELOG.md)

**Can't sign in as admin, or need a one-time code?** See [docs/ACCOUNTS.md](docs/ACCOUNTS.md). Short version: run `npm run admin`.

**First run:** set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` (and `DATA_KEY` from `openssl rand -hex 32`). The admin account is created at startup; the admin then creates inspectors and issues one-time setup codes from the Users tab. Donors, NGOs, organisers and distributors register themselves.

Login, sessions, two-factor authentication, roles, ownership checks and per-role data views are enforced **on the server** (docs/SECURITY.md). The hosted preview page cannot reach a server, so it runs in a browser-only demo mode. Read docs/CHECKLIST.md for exactly what is and is not built.
=======
# foodShare1
>>>>>>> 1057869b8406b4f116a42a95d77bb1b92495e946
