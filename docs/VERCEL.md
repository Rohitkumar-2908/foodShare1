# Deploying FoodShare on Vercel

Vercel runs the API as short-lived serverless functions, so FoodShare needs a hosted database. Use **MongoDB Atlas** (free tier is enough).

## 1. MongoDB Atlas (5 minutes)
1. Create a free cluster at https://cloud.mongodb.com.
2. **Database Access** → add a database user (username + password).
3. **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`). Vercel has no fixed IP addresses, so this is required. The database user's password is what protects it.
4. **Connect → Drivers** → copy the connection string, for example
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   (replace `USER` and `PASSWORD`; if the password has special characters such as `@` or `#`, URL-encode them).

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)
| Name | Required | Value |
|---|---|---|
| `MONGODB_URI` | **yes** | the connection string from step 1 |
| `DATA_KEY` | **yes** | 64 hex characters. Generate with `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep it forever: it encrypts two-factor secrets. |
| `ADMIN_EMAIL` | recommended | email of the first admin |
| `ADMIN_PASSWORD` | recommended | 8+ characters, letters and a number, not common, must not contain the first part of the email (for `admin@x.com` avoid "admin"). Used only the first time. |
| `METRICS_TOKEN` | optional | bearer token for `/metrics` |
| `MONGODB_DB` | optional | database name (default `foodshare`) |

Tick **Production**, **Preview** and **Development**, then **redeploy** (variables are read at build/start, so changes need a new deployment).

## 3. Deploy
* Push the project to GitHub/GitLab/Bitbucket and **Import Project** in Vercel, or run `npx vercel --prod` in this folder.
* Leave the framework preset as **Other**. `vercel.json` already sets everything (output folder `public`, the `/api` function, rewrites, security headers). No build command is needed.
* Open the site, then sign in as admin at `/#login-admin`.

## What happens if something is missing
The site never shows an error page. If `MONGODB_URI` or `DATA_KEY` is missing, `GET /api/v1/health` answers 200 with `"auth": false` and a `missing` list, and the page quietly runs in its browser-only demo mode (badge at the bottom-left says "Browser local storage"). Open `https://YOUR-SITE/api/v1/health` to see exactly what is missing. If the database is unreachable, the API answers `503 db_unavailable` and recovers on its own when the database returns. Logs: Vercel → Project → Logs.

## How it differs from Docker / `npm start`
* MongoDB only. The local `data/db.json` fallback is disabled on Vercel, because every function instance has its own throwaway disk and a fallback would silently fork your data.
* No background timers. Audit events and webhooks are flushed before each response finishes; expired sessions are cleaned up lazily (at most every 10 minutes per instance).
* No automatic file backups. Enable **Atlas backups** (or run `npm run backup` on your own machine with `MONGODB_URI` set).
* Rate limiting, sign-in lockouts and idempotency keys live in memory **per instance**, so they are weaker than on a single server. Use Vercel Firewall rate limits for stronger protection.
* `/metrics` counters are per instance and reset on cold starts; use Vercel Observability instead.
* To create or reset an admin from your own machine: put `MONGODB_URI` and `DATA_KEY` in a local `.env`, then run `npm run admin`.

## Testing before you deploy
`npm test` runs 73 tests, including `test/vercel.test.js`, which emulates Vercel's routing (static files, `vercel.json` rewrites, several function instances sharing one database, database outages, missing settings).
