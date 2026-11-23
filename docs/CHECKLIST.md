# What is and is not built

Legend: **Tested** = covered by the 54 automated tests or run here. **Built, untested** = written but not run here (no Docker, nginx, MongoDB or real browser available). **Docs only**. **Not built**.

## Tested
Authentication (scrypt, login, register, logout) · session management (HttpOnly/SameSite cookies, rotation at login, idle and absolute expiry, sign-out-everywhere, revoke on suspend and password change) · token expiration · two-factor authentication (TOTP + recovery codes) · password reset flow (admin-issued one-time codes) · account lockout and brute-force protection (including pickup codes) · authorisation: role-based access control · principle of least privilege (role/verification gates) · IDOR protection (ownership checks) · row-level security via per-role views · mass-assignment protection · CSRF protection · cookie flags · hashing vs encryption (scrypt for passwords, AES-GCM for 2FA secrets) · secrets from files and log redaction · secret rotation (webhook secrets) · audit logs · input and data validation on the server · file-upload validation (JPEG magic bytes, size) · XSS output escaping + CSP header · clickjacking protection · path traversal · SSRF guard · open redirects (none exist) · SQL/command injection (no SQL or shell used) · rate limiting · HTTP status codes · error handling without leaks · timeouts · exponential backoff with jitter · circuit breaker · idempotency keys · race conditions and optimistic locking · soft deletes · GDPR-style export and erase · database fallback and reconcile (fake MongoDB) · data migrations · backups with rotation and restore · message queue with retries and dead-letter · background jobs · scheduled jobs · signed webhooks · structured logging · request IDs and trace-id propagation · Prometheus metrics · health checks · graceful shutdown · feature flags · API versioning · ETag/304 caching and cache invalidation · load-test script · performance budget · UTF-8 and UTC timestamps · semantic versioning · unit and integration tests · the real frontend code running against the real server through a fake DOM (login, register, profile, listing, views, verification, fallback to browser mode, and every dashboard tab of all six roles rendering with real data).

## Built, untested here
Live MongoDB connection, pooling, read-replica setting, audit-collection indexes · nginx reverse proxy, load balancing, API-gateway routing, per-route throttling, edge cache and TLS termination · HTTPS/TLS in practice · Docker image and docker-compose (non-root, read-only, secrets) · GitHub Actions CI and Dependabot (dependency vulnerability scanning) · Prometheus alert rules · the visual styling (spatial, neumorphic, glass) in a real browser · the 3D scenes, 3D photo ring, photo zoom, chat robot and Claude-powered assistant in a real browser · staging environment (same compose file, different secrets) · infrastructure as code (Compose and nginx only).

## Partly built
* Rate-limit and lockout counters are per instance (see SECURITY).
* Distributed tracing: ids propagate, no tracing backend.
* Stateless services: sessions live in the database so instances are interchangeable; the file fallback is per machine.
* Accessibility and mobile layout: labels, focus rings, reduced-motion and high-contrast CSS exist; no audit or device test run.
* GDPR: export, erase, terms and privacy text. No consent log or data-processing agreement; not legal compliance.
* Memory leaks: in-memory maps are bounded or swept; not profiled over time.
* Stored view data: one document, not normalised collections.

## Docs only
Architecture and system design · normalisation plan · horizontal vs vertical scaling · disaster-recovery plan (RPO/RTO) · uptime monitoring setup · branching strategy · code review (CODEOWNERS and PR template provided) · technical debt · profiling and debugging how-to · encryption at rest for the database (use Atlas or disk encryption) · AI-assisted documentation (drafted with AI, needs human review).

## Not built
Email delivery, email verification and emailed reset links · magic links · passkeys · single sign-on · API keys for third-party clients · penetration testing (I wasn't sure what "Panetra" meant; if you meant penetration testing, it has not been done) · error tracking (Sentry) · cost monitoring · end-to-end tests in a real browser (Playwright) · durable message queue (Redis/BullMQ) · normalised collections and per-field indexes · Terraform · malware scanning of uploads.
