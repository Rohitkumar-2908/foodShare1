# Architecture and system design

```
 Browser (public/index.html)
    │ HTTPS
    ▼
 nginx  ── TLS termination, HTTP→HTTPS, gzip, edge cache for static files,
    │      rate limit, versioned routing (/api/v1/ → app, other /api/ → 410),
    │      least-connections load balancing, failover
    ├──────────────┐
    ▼              ▼
  app1           app2        stateless Node processes (same image)
    │              │         /healthz liveness · /readyz readiness · /metrics
    └──────┬───────┘
           ▼
   Store (src/store.js)
     ├─ circuit breaker ─▶ MongoDB  (state doc with revision, audit collection with TTL index)
     └─ fallback ────────▶ data/db.json (+ backups/, audit.log)
   In-process queue ─▶ audit writes, signed webhooks, alerts (retry + backoff + dead-letter)
   Scheduler ─────────▶ hourly backup, idempotency/limiter cleanup
```

## Request path
`request → request id + traceparent → rate limit → origin + session + CSRF check → role and ownership check (src/domain.js) → validation → store.update (compare-and-set on revision, retried) → response with the caller's own data view` Errors go through one handler that returns `{error:{code,message,requestId}}` and never leaks internals.

## Key decisions
| Decision | Why | Trade-off |
|---|---|---|
| Whole app state is one document with a revision number (server-side only; clients never receive it) | Fastest way to give the existing browser app a real database | No per-collection indexes, no row-level security, 16 MB document limit in MongoDB. Move to collections (below) before real use. |
| Optimistic concurrency (`If-Match`) | Prevents two clients silently overwriting each other (race conditions) | A losing client reloads and loses its unsaved change |
| Circuit breaker around MongoDB | A dead database fails fast instead of making every request wait for a timeout | Briefly serves from the file copy |
| File fallback mirrors every MongoDB write | The file is always at least as new as MongoDB when an outage starts | With several instances each has its own file, so use one instance or a shared volume during outages |
| In-process queue | Simple, no extra service | Not durable. Use Redis + BullMQ when jobs must survive a crash. |

## Scaling
* **Horizontal:** app instances are stateless apart from in-memory rate-limit counters (per instance) and the 1-second read cache. Add instances behind nginx.
* **Vertical:** one Node process uses one CPU core; add instances rather than bigger containers.
* **Read replicas:** `MONGO_READ_PREFERENCE=secondaryPreferred` with a replica-set URI. **Connection pooling:** `MONGO_MAX_POOL` / `MONGO_MIN_POOL`.
* **Caching/CDN:** static files carry `ETag` and `Cache-Control`; nginx caches them at the edge; a CDN can sit in front using the same headers. The state endpoint is `no-cache` + `ETag` (304 when unchanged). Cache invalidation: the in-memory copy is replaced on every write and expires after 1 s.

## Recommended normalised model (next step, not built)
Collections: `users`, `donations`, `orders`, `drives`, `messages`, `audit`. Indexes: `users.email` (unique), `donations {status, area, createdAt}`, `orders {requesterId, status}`, `orders {distributorId, status}`, `audit {ts}` (TTL). Soft delete via `deletedAt` (migration 3 already adds it). Orders reference donations and users by id.

## Time and encoding
Timestamps are UTC epoch milliseconds, shown in the viewer's local time zone. Text is UTF-8 and responses declare `charset=utf-8`.
