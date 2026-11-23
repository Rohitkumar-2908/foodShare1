# Security

All of this is enforced **on the server** (src/auth.js, src/domain.js, server.js) and covered by automated tests unless marked otherwise.

## Who you are (authentication)
* Passwords hashed with **scrypt** (per-user random salt). Old SHA-256 hashes are upgraded to scrypt at the next login. Policy: 8 to 128 characters, letters and a number, not a common password.
* Sessions: random 256-bit token in an **HttpOnly, SameSite=Strict** cookie (`Secure` automatically when served over HTTPS, including behind a trusted proxy). Only a hash of the token is stored. A new token is issued at every login (no session fixation), idle timeout 30 min, absolute limit 8 h, max 5 sessions per user, logout and "sign out of all devices", sessions die when an account is suspended or removed, other sessions are revoked on password change or reset.
* **CSRF:** every state-changing request needs the per-session `X-CSRF-Token` header and a same-origin `Origin` header.
* **Brute force:** login attempts are locked out per email (5) and per IP (30) for 15 minutes, on top of strict rate limits on auth endpoints. Unknown emails and wrong passwords give the same answer and similar timing.
* **Two-factor authentication:** TOTP (RFC 6238) with 8 single-use recovery codes. The TOTP secret is encrypted at rest (AES-256-GCM, key from `DATA_KEY`). The password step gives only a short-lived signed ticket, never a session.
* **Password reset:** one-time codes (single use, hashed at rest, 30 minutes) issued by the admin. New inspectors are created the same way (24 hours). No password is ever emailed or shown.
* The admin account is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` (or `_FILE`). Nobody can self-register as admin or inspector.

## What you may do (authorisation)
* Every action is a named server endpoint with a role list, an ownership check and a state check. Wrong role: 403. Someone else's record: 404 (no information leak). Examples tested: donors cannot approve food, NGOs cannot create donations, only the owner can edit, cancel or receive, and a distributor cannot use another distributor's order.
* NGOs, organisers and distributors must be **verified** by the admin or an inspector before ordering or delivering.
* **Row-level views:** the server builds each user's data view. Donors see only their own listings; NGOs only approved food and their own orders; distributors only open orders and their own deliveries, with the exact pickup address and phone numbers revealed only after accepting; staff see staff-level details; only the admin sees contact messages. Password hashes, TOTP secrets and other people's assistant memory are never sent. Pickup codes are visible only to the donor who owns the listing.
* **Mass assignment** is blocked: each action reads only named fields; ownership, status, approval and role cannot be set by the client.
* Pickup codes: 4 digits, compared in constant time, locked for 15 minutes after 5 wrong tries.
* Race conditions: each action is one compare-and-set write, so two buyers cannot take the same meals.

## Data and transport
* Input validation on every field (types, ranges, lengths, allowed values). Profile photos must be real JPEGs (magic bytes checked) under 60 KB. Responses never contain stack traces. Strings are escaped when drawn in the page and a Content-Security-Policy is sent.
* Security headers: CSP (scripts and styles only from this site and cdnjs.cloudflare.com; map tile images only from basemaps.cartocdn.com) with `frame-ancestors 'none'`, HSTS over HTTPS, `nosniff`, referrer and permissions policies, COOP/CORP.
* Webhooks are HMAC-signed with rotating secrets, and outbound requests block private addresses and refuse redirects.
* Audit trail of sign-ins, failures, denied actions and changes (MongoDB `audit` with TTL index, or `data/audit.log`) plus a security log visible to staff.
* Account deletion erases personal data and keeps anonymised order records.

## Known limits (be honest with yourself before launch)
* **Rate-limit and lockout counters are per server instance** (in memory). With several instances an attacker gets that many tries. Use nginx's limits (provided) or Redis.
* **No email:** there is no email verification and no emailed reset links; the admin hands out reset codes. Magic links, passkeys, single sign-on and API keys are not built.
* The data is still one document, so a very large deployment needs the normalised model in ARCHITECTURE.md.
* Cookie name has no `__Host-` prefix (needs HTTPS everywhere). Serve over HTTPS in production.
* If `DATA_KEY` is not set, a key file is created next to the data. That protects against casual leaks of the database, not against someone who copies the whole data folder. Set `DATA_KEY` in production.
* The in-process job queue loses queued jobs if the process crashes.
* No malware scanning, no penetration test, no error-tracking service, no consent log. The AI assistant only receives role-scoped data and a prompt-injection filter runs in the browser (a determined user can bypass the filter, but cannot get data the server will not give them).
* The hosted preview page cannot reach a server, so it runs in browser-only demo mode where none of the above applies.
