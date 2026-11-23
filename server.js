"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { getConfig, loadEnvFile, serverlessProblems } = require("./src/config");
const { makeLogger } = require("./src/log");
const { Metrics } = require("./src/metrics");
const { RateLimiter } = require("./src/resilience");
const { Queue, Scheduler } = require("./src/queue");
const { Store } = require("./src/store");
const { deliver } = require("./src/webhook");
const Admin = require("./src/admin");
const A = require("./src/auth");
const D = require("./src/domain");
const { HttpError } = D;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.basemaps.cartocdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TP_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const COOKIE = "fs_sid";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function createApp(over = {}) {
  const cfg = Object.assign(getConfig(), over);
  const log = makeLogger(process.env.LOG_LEVEL || "info");
  const metrics = new Metrics();
  const queue = new Queue({ log, metrics, baseMs: over.queueBaseMs || 200 });
  const store = new Store(cfg, { log, metrics, mongoFactory: over.mongoFactory, onCircuitOpen: () => queue.push("alert", { type: "alert.circuit_open", service: "mongodb" }) });
  const limiter = new RateLimiter({ capacity: cfg.rateCapacity, refillPerSec: cfg.rateRefillPerSec });
  const wlimiter = new RateLimiter({ capacity: cfg.writeCapacity, refillPerSec: cfg.writeRefillPerSec });
  const alimiter = new RateLimiter({ capacity: cfg.authCapacity, refillPerSec: cfg.authRefillPerSec });
  const scheduler = new Scheduler(log);
  const idem = new Map(), locks = new Map();
  const st = { shuttingDown: false };
  const serverless = !!cfg.serverless;
  cfg.problems = serverlessProblems(cfg); // missing settings that make the API unusable on serverless
  let KEY = null, adminStatus = null;
  const IDLE = cfg.sessionIdleMin * 60000, ABS = cfg.sessionAbsHours * 3600000;

  queue.register("audit", (e) => store.audit(e));
  queue.register("webhook", (e) => deliver(cfg, e));
  queue.register("alert", async (e) => { log("error", "ALERT", e); if (cfg.webhookUrl && cfg.flags.has("webhooks")) await deliver(cfg, e); });
  metrics.gauge("foodshare_queue_depth", () => queue.depth());
  metrics.gauge("foodshare_dead_letter_jobs", () => queue.dead.length);
  metrics.gauge("foodshare_db_mongodb_active", () => (store.mode === "mongodb" ? 1 : 0));
  metrics.gauge("foodshare_circuit_open", () => (store.breaker.state === "closed" ? 0 : 1));
  metrics.gauge("foodshare_idempotency_keys", () => idem.size);
  metrics.gauge("process_resident_memory_bytes", () => process.memoryUsage().rss);

  // ---------- helpers ----------
  const isHttps = (req) => !!req.socket.encrypted || (cfg.trustProxy && req.headers["x-forwarded-proto"] === "https");
  function clientIp(req) {
    if (cfg.trustProxy && req.headers["x-forwarded-for"]) { const ip = String(req.headers["x-forwarded-for"]).split(",")[0].trim(); if (net.isIP(ip)) return ip; }
    return req.socket.remoteAddress || "unknown";
  }
  function hdr(req, extra) {
    const h = Object.assign({
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(), camera=(), microphone=()", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": CSP,
      "X-Request-Id": req.c.rid, traceparent: req.c.traceparent,
    }, extra);
    if (isHttps(req)) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    if (st.shuttingDown) h.Connection = "close";
    if (cfg.corsOrigin) {
      h["Access-Control-Allow-Origin"] = cfg.corsOrigin; h.Vary = "Origin"; h["Access-Control-Allow-Credentials"] = "true";
      h["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"; h["Access-Control-Allow-Headers"] = "Content-Type, X-CSRF-Token, Idempotency-Key, If-None-Match";
      h["Access-Control-Expose-Headers"] = "ETag, Retry-After, Idempotent-Replay";
    }
    return h;
  }
  function send(res, req, status, body, extra) {
    const isJson = body !== null && typeof body === "object";
    const payload = body === null || body === undefined ? "" : isJson ? JSON.stringify(body) : String(body);
    res.writeHead(status, hdr(req, Object.assign({ "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store" }, extra)));
    res.end(status === 304 || status === 204 ? undefined : payload);
  }
  const fail = (res, req, status, code, message, extra, more) => send(res, req, status, { error: Object.assign({ code, message, requestId: req.c.rid }, more) }, extra);
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > max) { const e = new Error("payload too large"); e.status = 413; reject(e); req.resume(); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  async function jsonBody(req, res, max = 256 * 1024) {
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) { req.resume(); fail(res, req, 415, "unsupported_media_type", "Content-Type must be application/json"); return null; }
    if (Number(req.headers["content-length"]) > max) { req.resume(); fail(res, req, 413, "payload_too_large", "Request body is too large", { Connection: "close" }); return null; }
    let raw;
    try { raw = await readBody(req, max); } catch (e) { if (e.status === 413) { fail(res, req, 413, "payload_too_large", "Request body is too large", { Connection: "close" }); return null; } throw e; }
    try { const b = JSON.parse(raw.toString("utf8")); if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("not an object"); return { body: b, raw }; }
    catch (e) { fail(res, req, 400, "invalid_json", "Body must be a JSON object"); return null; }
  }
  const isLocal = (ip) => /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i.test(ip);
  const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase().slice(0, 100) : "");

  // ---------- sessions, CSRF, lockout ----------
  function parseCookies(h) {
    const o = {};
    String(h || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* ignore bad cookie */ } } });
    return o;
  }
  const cookie = (req, token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
  async function authenticate(req) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok || tok.length > 100) return null;
    const th = A.sha256(tok), now = Date.now();
    const env = await store.get(), s = env.state;
    if (!s) return null;
    const se = (s.sessions || []).find((x) => x.th === th);
    if (!se || se.exp <= now || se.seen + IDLE <= now) return null;
    const user = s.users.find((u) => u.id === se.uid);
    if (!user || user.sus || user.deletedAt) return null;
    if (now - se.seen > 5 * 60000) { se.seen = now; store.update((x) => { const q = x.sessions.find((z) => z.th === th); if (q) q.seen = now; }).catch(() => {}); }
    return { user, session: se, state: s, rev: env.rev };
  }
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host || (cfg.corsOrigin && o === cfg.corsOrigin); } catch (e) { return false; }
  }
  const lockedFor = (k) => { const l = locks.get(k); return l && l.until > Date.now() ? Math.ceil((l.until - Date.now()) / 1000) : 0; };
  function bump(k, max) {
    const l = locks.get(k) || { n: 0, until: 0 };
    if (l.until && l.until <= Date.now()) { l.n = 0; l.until = 0; }
    l.n++; if (l.n >= max) { l.until = Date.now() + cfg.lockoutMs; l.n = 0; }
    locks.set(k, l); return l.until > Date.now();
  }
  function issueSession(s, uid, now) {
    const token = A.newToken(), csrf = A.newToken().slice(0, 32);
    s.sessions = (s.sessions || []).filter((x) => x.exp > now && x.seen + IDLE > now);
    const mine = s.sessions.filter((x) => x.uid === uid).sort((a, b) => a.seen - b.seen);
    if (mine.length >= 5) s.sessions = s.sessions.filter((x) => x !== mine[0]);
    s.sessions.push({ id: D.nid(s), uid, th: A.sha256(token), csrf, exp: now + ABS, seen: now });
    return { token, csrf };
  }
  function authReply(req, res, s, uid, sess, status = 200) {
    const u = s.users.find((x) => x.id === uid);
    return send(res, req, status, { user: D.selfUser(u), csrf: sess.csrf, view: D.viewFor(s, u) }, { "Set-Cookie": cookie(req, sess.token, Math.floor(ABS / 1000)) });
  }
  async function startSession(req, res, uid, why, upgradePw) {
    const now = Date.now(); let sess;
    const r = await store.update((s) => {
      const u = s.users.find((x) => x.id === uid); if (!u) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
      if (upgradePw) { u.pw = upgradePw; delete u.hash; delete u.salt; } // upgrade old SHA-256 hashes to scrypt
      sess = issueSession(s, uid, now); D.evt(s, u.email + " signed in");
    });
    queue.push("audit", { type: "auth." + why, uid, ip: clientIp(req), rid: req.c.rid });
    return authReply(req, res, r.state, uid, sess);
  }

  // ---------- auth routes ----------
  async function guardPost(req, res, ip, needSession) {
    if (req.method !== "POST") { fail(res, req, 405, "method_not_allowed", "Use POST", { Allow: "POST" }); return null; }
    if (!originOk(req)) { req.resume(); fail(res, req, 403, "bad_origin", "Cross-origin request blocked"); return null; }
    const al = alimiter.take(ip);
    if (!al.ok) { req.resume(); fail(res, req, 429, "rate_limited", "Too many attempts. Slow down.", { "Retry-After": String(al.retryAfter) }); return null; }
    if (!needSession) return true;
    const a = await authenticate(req);
    if (!a) { req.resume(); fail(res, req, 401, "unauthenticated", "Please sign in"); return null; }
    if (!A.safeEq(req.headers["x-csrf-token"] || "", a.session.csrf)) { req.resume(); fail(res, req, 403, "csrf", "Missing or invalid CSRF token"); return null; }
    return a;
  }
  const badCreds = (res, req, lockedNow) => fail(res, req, 401, "invalid_credentials", "Email or password is incorrect.", lockedNow ? { "Retry-After": String(Math.ceil(cfg.lockoutMs / 1000)) } : {});

  async function authRoute(req, res, p, ip) {
    const sub = p.slice("/api/v1/auth/".length);
    if (sub === "me") {
      if (req.method !== "GET") return fail(res, req, 405, "method_not_allowed", "Use GET", { Allow: "GET" });
      const a = await authenticate(req);
      return a ? send(res, req, 200, { user: D.selfUser(a.user), csrf: a.session.csrf }) : fail(res, req, 401, "unauthenticated", "Please sign in");
    }
    if (sub === "register") {
      if (!(await guardPost(req, res, ip, false))) return;
      const j = await jsonBody(req, res); if (!j) return; const b = j.body;
      if (cfg.flags.has("readOnly")) return fail(res, req, 503, "read_only", "The service is in read-only maintenance mode", { "Retry-After": "60" });
      if (!D.SELF_ROLES.includes(b.role)) return fail(res, req, 422, "validation_failed", "Quality inspector and admin accounts are created by an admin.");
      const email = normEmail(b.email), name = typeof b.name === "string" ? b.name.trim() : "";
      if (name.length < 2 || name.length > 50) return fail(res, req, 422, "validation_failed", "Enter your name or organisation (2 to 50 characters).");
      if (!EMAIL_RE.test(email)) return fail(res, req, 422, "validation_failed", "Enter a valid email address.");
      const pp = A.passwordProblem(b.password, email); if (pp) return fail(res, req, 422, "validation_failed", pp);
      const pw = await A.hashPassword(b.password, cfg.scryptN), now = Date.now(); let sess, uid;
      try {
        const r = await store.update((s) => {
          if (s.users.some((u) => u.email === email)) throw new HttpError(409, "exists", "An account with this email already exists.");
          const u = D.newUser(s, { name, email, role: b.role, pw, now }); uid = u.id; sess = issueSession(s, uid, now); D.evt(s, "New " + b.role + " account: " + email);
        });
        queue.push("audit", { type: "auth.register", uid, role: b.role, ip, rid: req.c.rid });
        return authReply(req, res, r.state, uid, sess, 201);
      } catch (e) { if (e instanceof HttpError) return fail(res, req, e.status, e.code, e.message); throw e; }
    }
    if (sub === "login") {
      if (!(await guardPost(req, res, ip, false))) return;
      const j = await jsonBody(req, res); if (!j) return; const b = j.body;
      const email = normEmail(b.email), pw = b.password;
      if (!email || typeof pw !== "string" || pw.length > 200) return fail(res, req, 422, "validation_failed", "Enter your email and password.");
      const wait = Math.max(lockedFor("e:" + email), lockedFor("i:" + ip));
      if (wait) return fail(res, req, 429, "locked", "Too many failed attempts. Try again later.", { "Retry-After": String(wait) });
      const env = await store.get(), u = env.state && env.state.users.find((x) => x.email === email && !x.deletedAt);
      let ok = false, upgrade = null;
      if (u && u.pw) ok = await A.verifyPassword(pw, u.pw);
      else if (u && u.hash && u.salt) { ok = A.safeEq(A.sha256(u.salt + pw), u.hash); if (ok) upgrade = await A.hashPassword(pw, cfg.scryptN); }
      else await A.verifyPassword(pw, await A.dummyRecord(cfg.scryptN));
      if (!ok) { const lk = bump("e:" + email, cfg.lockoutAttempts) | bump("i:" + ip, cfg.lockoutIpAttempts); queue.push("audit", { type: "auth.failed", ip, rid: req.c.rid }); if (lk) log("warn", "login lockout", { ip }); return badCreds(res, req, lk); }
      if (u.sus) return fail(res, req, 403, "suspended", "This account is suspended. Contact an administrator.");
      locks.delete("e:" + email);
      if (u.totp && u.totp.on) return send(res, req, 200, { needs2fa: true, ticket: A.signTicket(KEY, { uid: u.id, exp: Date.now() + 5 * 60000 }) });
      return startSession(req, res, u.id, "login", upgrade);
    }
    if (sub === "login/2fa") {
      if (!(await guardPost(req, res, ip, false))) return;
      const j = await jsonBody(req, res); if (!j) return;
      const t = A.readTicket(KEY, j.body.ticket), code = typeof j.body.code === "string" ? j.body.code.trim() : "";
      if (!t) return fail(res, req, 401, "invalid_ticket", "Sign in again.");
      const lk = lockedFor("t:" + t.uid); if (lk) return fail(res, req, 429, "locked", "Too many wrong codes. Try again later.", { "Retry-After": String(lk) });
      const env = await store.get(), u = env.state.users.find((x) => x.id === t.uid);
      if (!u || u.sus || u.deletedAt || !u.totp || !u.totp.on) return fail(res, req, 401, "invalid_ticket", "Sign in again.");
      let good = false, usedRecovery = null;
      if (/^\d{6}$/.test(code)) good = A.verifyTotp(A.open(KEY, u.totp.sec), code);
      else if (/^[0-9a-f]{10}$/i.test(code)) { const h = A.sha256(code.toLowerCase()); if ((u.totp.rec || []).includes(h)) { good = true; usedRecovery = h; } }
      if (!good) { bump("t:" + t.uid, cfg.lockoutAttempts); return fail(res, req, 401, "invalid_code", "That code is not correct."); }
      locks.delete("t:" + t.uid);
      if (usedRecovery) await store.update((s) => { const q = s.users.find((x) => x.id === u.id); q.totp.rec = q.totp.rec.filter((h) => h !== usedRecovery); });
      return startSession(req, res, u.id, "login2fa", null);
    }
    if (sub === "logout" || sub === "logout-all") {
      if (req.method !== "POST") return fail(res, req, 405, "method_not_allowed", "Use POST", { Allow: "POST" });
      if (!originOk(req)) return fail(res, req, 403, "bad_origin", "Cross-origin request blocked");
      const a = await authenticate(req);
      if (a) {
        if (!A.safeEq(req.headers["x-csrf-token"] || "", a.session.csrf)) return fail(res, req, 403, "csrf", "Missing or invalid CSRF token");
        await store.update((s) => { s.sessions = s.sessions.filter((x) => (sub === "logout-all" ? x.uid !== a.user.id : x.th !== a.session.th)); });
      }
      return send(res, req, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) });
    }
    if (sub === "password") {
      const a = await guardPost(req, res, ip, true); if (!a) return;
      const j = await jsonBody(req, res); if (!j) return;
      const cur = j.body.current, nxt = j.body.next;
      if (typeof cur !== "string" || !(await A.verifyPassword(cur, a.user.pw))) return fail(res, req, 403, "wrong_password", "Your current password is not correct.");
      const pp = A.passwordProblem(nxt, a.user.email); if (pp) return fail(res, req, 422, "validation_failed", pp);
      const pw = await A.hashPassword(nxt, cfg.scryptN);
      await store.update((s) => { const u = s.users.find((x) => x.id === a.user.id); u.pw = pw; s.sessions = s.sessions.filter((x) => x.uid !== u.id || x.th === a.session.th); D.evt(s, u.email + " changed their password"); });
      return send(res, req, 200, { ok: true });
    }
    if (sub === "reset") {
      if (!(await guardPost(req, res, ip, false))) return;
      const j = await jsonBody(req, res); if (!j) return;
      const token = typeof j.body.token === "string" ? j.body.token.slice(0, 100) : "", th = A.sha256(token), now = Date.now();
      const env = await store.get(), r = env.state && (env.state.resets || []).find((x) => x.th === th && x.exp > now);
      if (!r) return fail(res, req, 400, "invalid_token", "That code is invalid or has expired.");
      const target = env.state.users.find((x) => x.id === r.uid);
      const pp = A.passwordProblem(j.body.password, target && target.email); if (pp) return fail(res, req, 422, "validation_failed", pp);
      const pw = await A.hashPassword(j.body.password, cfg.scryptN);
      try {
        await store.update((s) => {
          const q = s.resets.find((x) => x.th === th && x.exp > now); if (!q) throw new HttpError(400, "invalid_token", "That code is invalid or has expired.");
          const u = s.users.find((x) => x.id === q.uid); u.pw = pw; delete u.hash; delete u.salt;
          s.resets = s.resets.filter((x) => x !== q); s.sessions = s.sessions.filter((x) => x.uid !== u.id); D.evt(s, "Password set for " + u.email + " using a reset code");
        });
      } catch (e) { if (e instanceof HttpError) return fail(res, req, e.status, e.code, e.message); throw e; }
      locks.delete("e:" + target.email);
      return send(res, req, 200, { ok: true });
    }
    if (sub === "totp/setup" || sub === "totp/enable" || sub === "totp/disable") {
      const a = await guardPost(req, res, ip, true); if (!a) return;
      const j = await jsonBody(req, res); if (!j) return; const b = j.body;
      if (sub === "totp/setup") {
        const secret = A.newTotpSecret();
        await store.update((s) => { const u = s.users.find((x) => x.id === a.user.id); u.totp = { pending: A.seal(KEY, secret) }; });
        return send(res, req, 200, { secret, otpauth: `otpauth://totp/FoodShare:${encodeURIComponent(a.user.email)}?secret=${secret}&issuer=FoodShare` });
      }
      if (sub === "totp/enable") {
        const pend = a.user.totp && a.user.totp.pending;
        if (!pend) return fail(res, req, 409, "no_setup", "Start setup first.");
        const secret = A.open(KEY, pend);
        if (!A.verifyTotp(secret, String(b.code || "").trim())) return fail(res, req, 422, "invalid_code", "That code is not correct. Check the time on your phone.");
        const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString("hex"));
        await store.update((s) => { const u = s.users.find((x) => x.id === a.user.id); u.totp = { on: true, sec: A.seal(KEY, secret), rec: codes.map(A.sha256) }; D.evt(s, u.email + " turned on two-factor authentication"); });
        return send(res, req, 200, { ok: true, recoveryCodes: codes });
      }
      if (!a.user.totp || !a.user.totp.on) return fail(res, req, 409, "not_enabled", "Two-factor authentication is not on.");
      if (typeof b.password !== "string" || !(await A.verifyPassword(b.password, a.user.pw))) return fail(res, req, 403, "wrong_password", "Your password is not correct.");
      if (!A.verifyTotp(A.open(KEY, a.user.totp.sec), String(b.code || "").trim())) return fail(res, req, 422, "invalid_code", "That code is not correct.");
      await store.update((s) => { const u = s.users.find((x) => x.id === a.user.id); u.totp = null; D.evt(s, u.email + " turned off two-factor authentication"); });
      return send(res, req, 200, { ok: true });
    }
    return fail(res, req, 404, "not_found", "Unknown endpoint");
  }

  // ---------- data routes ----------
  async function viewRoute(req, res) {
    if (req.method !== "GET") return fail(res, req, 405, "method_not_allowed", "Use GET", { Allow: "GET" });
    const a = await authenticate(req), env = a ? { rev: a.rev, state: a.state } : await store.get(), s = env.state || D.emptyState();
    const user = a ? s.users.find((u) => u.id === a.user.id) : null;
    const etag = '"' + env.rev + "-" + (user ? user.id : 0) + '"';
    if (req.headers["if-none-match"] === etag) return send(res, req, 304, null, { ETag: etag, Vary: "Cookie" });
    return send(res, req, 200, Object.assign({ view: D.viewFor(s, user), user: user ? D.selfUser(user) : null, csrf: a ? a.session.csrf : null, rev: env.rev }, store.info()), { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie" });
  }
  async function contactRoute(req, res, ip) {
    if (!(await guardPost(req, res, ip, false))) return;
    const j = await jsonBody(req, res); if (!j) return; const b = j.body;
    const n = typeof b.name === "string" ? b.name.trim() : "", e = normEmail(b.email), t = typeof b.message === "string" ? b.message.trim() : "";
    if (n.length < 2 || n.length > 50) return fail(res, req, 422, "validation_failed", "Enter your name.");
    if (!EMAIL_RE.test(e)) return fail(res, req, 422, "validation_failed", "Enter a valid email address.");
    if (t.length < 10 || t.length > 500) return fail(res, req, 422, "validation_failed", "Write 10 to 500 characters.");
    await store.update((s) => { s.msg.push({ id: D.nid(s), n, e, t, at: Date.now() }); if (s.msg.length > 2000) s.msg.shift(); });
    return send(res, req, 201, { ok: true });
  }
  async function actionRoute(req, res, name, ip) {
    const a = await guardPost(req, res, ip, true); if (!a) return;
    const spec = D.ACTIONS[name];
    if (!spec) { req.resume(); return fail(res, req, 404, "unknown_action", "Unknown action"); }
    if (!spec.roles.includes(a.user.role)) { req.resume(); queue.push("audit", { type: "authz.denied", uid: a.user.id, action: name, ip, rid: req.c.rid }); return fail(res, req, 403, "forbidden", "Your account type cannot do that."); }
    if (cfg.flags.has("readOnly")) { req.resume(); return fail(res, req, 503, "read_only", "The service is in read-only maintenance mode", { "Retry-After": "60" }); }
    const w = wlimiter.take(ip + ":" + a.user.id);
    if (!w.ok) { req.resume(); return fail(res, req, 429, "rate_limited", "Too many changes. Slow down.", { "Retry-After": String(w.retryAfter) }); }
    const key = req.headers["idempotency-key"];
    if (key !== undefined && !ID_RE.test(String(key))) { req.resume(); return fail(res, req, 400, "bad_idempotency_key", "Idempotency-Key must be 1-64 characters: letters, digits, _ . : -"); }
    const j = await jsonBody(req, res); if (!j) return;
    const exec = async () => {
      try {
        const r = await store.update((s) => {
          const u = s.users.find((x) => x.id === a.user.id);
          if (!u || u.sus || u.deletedAt) throw new HttpError(401, "unauthenticated", "Please sign in");
          if (spec.verified && u.ver !== "verified") throw new HttpError(403, "not_verified", "Your account is awaiting verification by the admin.");
          return spec.run(s, { user: u, now: Date.now(), ip }, j.body);
        });
        queue.push("audit", { type: "action." + name, uid: a.user.id, ip, rid: req.c.rid });
        if (cfg.webhookUrl && cfg.flags.has("webhooks")) queue.push("webhook", { type: "state.updated", rev: r.rev, at: Date.now() });
        const me = r.state.users.find((x) => x.id === a.user.id);
        const user = me && !me.deletedAt ? me : null;
        return { status: 200, body: { ok: true, result: r.result, view: D.viewFor(r.state, user), user: user ? D.selfUser(user) : null, rev: r.rev } };
      } catch (e) {
        if (e instanceof HttpError) {
          if (e.code === "forbidden" || e.code === "not_verified") queue.push("audit", { type: "authz.denied", uid: a.user.id, action: name, ip, rid: req.c.rid });
          return { status: e.status, body: { error: Object.assign({ code: e.code, message: e.message, requestId: req.c.rid }, e.extra) }, headers: e.extra && e.extra.retryAfterSec ? { "Retry-After": String(e.extra.retryAfterSec) } : {} };
        }
        if (e && e.conflict) return { status: 409, body: { error: { code: "busy", message: "The data is busy. Please try again.", requestId: req.c.rid } } };
        throw e;
      }
    };
    if (!key) { const r = await exec(); return send(res, req, r.status, r.body, r.headers); }
    const k = a.user.id + ":" + key, fp = crypto.createHash("sha256").update(name + "|" + j.raw.toString("utf8")).digest("hex");
    const hit = idem.get(k);
    if (hit) {
      if (hit.fp !== fp) return fail(res, req, 422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request");
      const r = await hit.promise;
      return send(res, req, r.status, r.body, Object.assign({ "Idempotent-Replay": "true" }, r.headers));
    }
    const promise = exec(); idem.set(k, { at: Date.now(), fp, promise });
    try { const r = await promise; if (r.status >= 500) idem.delete(k); return send(res, req, r.status, r.body, r.headers); } catch (e) { idem.delete(k); throw e; }
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return fail(res, req, 400, "bad_request", "Malformed path"); }
    if (rel.includes("\0")) return fail(res, req, 400, "bad_request", "Malformed path");
    if (rel === "/") rel = "/index.html";
    const root = cfg.publicDir, file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) return fail(res, req, 403, "forbidden", "Forbidden");
    let s;
    try { s = await fsp.stat(file); if (!s.isFile()) throw new Error("not a file"); } catch (e) { return fail(res, req, 404, "not_found", "Not found"); }
    const etag = 'W/"' + s.size.toString(16) + "-" + Math.floor(s.mtimeMs).toString(16) + '"';
    const cc = file.endsWith(".html") ? "no-cache" : "public, max-age=3600";
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, hdr(req, { ETag: etag, "Cache-Control": cc })); return res.end(); }
    res.writeHead(200, hdr(req, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": s.size, ETag: etag, "Cache-Control": cc }));
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ---------- serverless (Vercel) support ----------
  let readyP = null, failedAt = 0, lastErr = null, lastMaint = Date.now();
  // Cold start work shared by every request that arrives meanwhile. A failure is remembered for 5 s, then retried.
  function ensureReady() {
    if (readyP) return readyP;
    if (Date.now() - failedAt < 5000) return Promise.reject(lastErr);
    readyP = prepare().catch((e) => { readyP = null; failedAt = Date.now(); lastErr = e; log("error", "startup failed", { err: e.message }); throw e; });
    return readyP;
  }
  queue.register("maintenance", async () => { // expired sessions and reset codes, only written when there is something to remove
    const env = await store.get({ fresh: true }), s = env.state, now = Date.now();
    const dirty = s && ((s.sessions || []).some((x) => x.exp <= now || x.seen + IDLE <= now) || (s.resets || []).some((x) => x.exp <= now));
    if (dirty) await store.update((x) => { x.sessions = x.sessions.filter((y) => y.exp > now && y.seen + IDLE > now); x.resets = x.resets.filter((y) => y.exp > now); });
  });
  function maintain() { // there are no timers on serverless, so housekeeping piggybacks on requests (at most every 10 minutes per instance)
    const now = Date.now(); if (now - lastMaint < 10 * 60000) return; lastMaint = now;
    for (const [k, v] of idem) if (now - v.at > 10 * 60000) idem.delete(k);
    for (const [k, l] of locks) if (l.until < now && l.n === 0) locks.delete(k);
    limiter.sweep(); wlimiter.sweep(); alimiter.sweep(); queue.push("maintenance", {});
  }
  // Returns true when it already answered the request.
  async function serverlessGate(req, res, p) {
    const needsApi = p.startsWith("/api/") || p === "/readyz" || p === "/metrics";
    if (!needsApi) return false;
    if (cfg.problems.length) {
      log("error", "serverless configuration incomplete", { missing: cfg.problems });
      // Health answers 200 with auth:false, so the page quietly switches to its browser-only demo mode instead of showing errors.
      if (p === "/api/v1/health" && req.method === "GET") return send(res, req, 200, { ok: true, version: "3.0.0", auth: false, configured: false, missing: cfg.problems, label: "Browser local storage", message: "Set these environment variables in Vercel, then redeploy: " + cfg.problems.join(", ") }), true;
      return fail(res, req, 503, "not_configured", "The server is not configured yet. Missing: " + cfg.problems.join(", "), { "Retry-After": "60" }), true;
    }
    try { await ensureReady(); } catch (e) { return fail(res, req, 503, "db_unavailable", "The database is not reachable right now. Please try again in a moment.", { "Retry-After": "5" }), true; }
    maintain();
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost"), p = url.pathname, ip = clientIp(req);
    if (req.method === "OPTIONS") { res.writeHead(204, hdr(req, {})); return res.end(); }
    if (p === "/healthz") return send(res, req, 200, { status: "ok" });
    if (serverless && (await serverlessGate(req, res, p))) return;
    if (p === "/readyz") { const ready = store.started && !st.shuttingDown; return send(res, req, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", draining: st.shuttingDown }); }
    if (p === "/metrics") {
      if (!cfg.flags.has("metrics")) return fail(res, req, 404, "not_found", "Not found");
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "");
      const ok = cfg.metricsToken ? !!bearer && A.safeEq(bearer[1], cfg.metricsToken) : isLocal(ip);
      if (!ok) return fail(res, req, cfg.metricsToken ? 401 : 403, cfg.metricsToken ? "unauthorized" : "forbidden", "Metrics are not available to this client");
      return send(res, req, 200, metrics.render(), { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    }
    if (p.startsWith("/api/")) {
      const rl = limiter.take(ip);
      if (!rl.ok) return fail(res, req, 429, "rate_limited", "Too many requests", { "Retry-After": String(rl.retryAfter), "X-RateLimit-Limit": String(cfg.rateCapacity), "X-RateLimit-Remaining": "0" });
      if (p === "/api/v1/health" && req.method === "GET") { const env = await store.get(); const needsAdmin = !(env.state && env.state.users.some((u) => u.role === "admin" && !u.deletedAt)); return send(res, req, 200, Object.assign({ ok: true, version: "3.0.0", auth: true, needsAdmin }, store.info()), { "X-RateLimit-Remaining": String(rl.remaining) }); }
      if (p === "/api/v1/flags" && req.method === "GET") return send(res, req, 200, { flags: Array.from(cfg.flags) });
      if (p === "/api/v1/view") return viewRoute(req, res);
      if (p === "/api/v1/contact") return contactRoute(req, res, ip);
      if (p.startsWith("/api/v1/auth/")) return authRoute(req, res, p, ip);
      const m = /^\/api\/v1\/actions\/([A-Za-z.]{3,40})$/.exec(p);
      if (m) return actionRoute(req, res, m[1], ip);
      if (p === "/api/v1/state") return fail(res, req, 410, "gone", "Whole-state access was removed. Use /api/v1/view and /api/v1/actions/*.");
      if (p.startsWith("/api/v1/")) return fail(res, req, 404, "not_found", "Unknown endpoint");
      return fail(res, req, 410, "version_gone", "This API version is retired. Use /api/v1/.");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, req, 405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
    return serveStatic(req, res, p);
  }

  function onRequest(req, res) {
    const t0 = process.hrtime.bigint(), tp = TP_RE.exec(String(req.headers.traceparent || ""));
    const trace = tp ? tp[1] : crypto.randomBytes(16).toString("hex");
    const rid = ID_RE.test(String(req.headers["x-request-id"] || "")) ? String(req.headers["x-request-id"]) : crypto.randomUUID();
    req.c = { rid, trace, traceparent: `00-${trace}-${crypto.randomBytes(8).toString("hex")}-01` };
    if (serverless) { // a frozen function would lose queued audit/webhook jobs, so finish them before the response ends
      const end = res.end;
      res.end = function (...a) { queue.drain(4000).catch(() => {}).then(() => end.apply(this, a)); return this; };
    }
    res.on("finish", () => {
      const sec = Number(process.hrtime.bigint() - t0) / 1e9;
      const route = req.url.startsWith("/api/") ? req.url.split("?")[0] : /^\/(healthz|readyz|metrics)/.test(req.url) ? req.url : "static";
      metrics.inc("http_requests_total", { method: req.method, route, status: res.statusCode });
      metrics.observe("http_request_duration_seconds", { route }, sec);
      log(res.statusCode >= 500 ? "error" : "info", "request", { method: req.method, path: route, status: res.statusCode, ms: Math.round(sec * 1000), ip: clientIp(req), requestId: rid, traceId: trace });
    });
    handle(req, res).catch((e) => {
      log("error", "unhandled error", { err: e.message, stack: cfg.env === "production" ? undefined : e.stack, requestId: rid });
      if (res.headersSent) return res.destroy();
      if (e && e.dbUnavailable) fail(res, req, 503, "db_unavailable", "The database is not reachable right now. Please try again in a moment.", { "Retry-After": "5" });
      else fail(res, req, 500, "internal_error", "Something went wrong");
    });
  }
  const server = http.createServer(onRequest);
  server.requestTimeout = cfg.requestTimeoutMs; server.headersTimeout = Math.min(10000, cfg.requestTimeoutMs); server.keepAliveTimeout = 5000;

  // Everything that must happen before the first request (shared by the long-running server and by serverless cold starts).
  async function prepare() {
    KEY = A.loadKey(cfg.dataDir);
    await store.init(); await store.migrateOnStart(); adminStatus = await Admin.bootstrapAdmin(store, cfg);
    if (adminStatus.status === "rejected") log("error", "ADMIN_PASSWORD rejected, no admin created", { reason: adminStatus.reason });
    if (adminStatus.status === "missing") log("warn", "no admin account exists: set ADMIN_EMAIL and ADMIN_PASSWORD");
  }
  async function start() {
    await prepare();
    scheduler.every("backup", cfg.backupIntervalMin * 60000, () => store.backup());
    scheduler.every("cleanup", 60000, () => {
      const now = Date.now();
      for (const [k, v] of idem) if (now - v.at > 10 * 60000) idem.delete(k);
      for (const [k, l] of locks) if (l.until < now && l.n === 0) locks.delete(k);
      limiter.sweep(); wlimiter.sweep(); alimiter.sweep();
      store.update((s) => { s.sessions = s.sessions.filter((x) => x.exp > now && x.seen + IDLE > now); s.resets = s.resets.filter((x) => x.exp > now); }).catch(() => {});
    });
    await new Promise((r) => server.listen(cfg.port, cfg.host, r));
    return server;
  }
  async function shutdown(reason = "signal") {
    if (st.shuttingDown) return; st.shuttingDown = true;
    log("info", "graceful shutdown started", { reason }); scheduler.stop();
    const closed = new Promise((r) => server.close(r));
    const sweep = setInterval(() => server.closeIdleConnections && server.closeIdleConnections(), 100);
    const force = setTimeout(() => server.closeAllConnections && server.closeAllConnections(), cfg.shutdownMs); force.unref();
    await closed; clearInterval(sweep); clearTimeout(force);
    await queue.drain(Math.min(5000, cfg.shutdownMs)); await store.close();
    log("info", "graceful shutdown complete");
  }
  return { cfg, server, store, queue, metrics, start, shutdown, state: st, handler: onRequest, ensureReady, get adminStatus() { return adminStatus; } };
}
module.exports = { createApp, CSP };

if (require.main === module) {
  const envFound = loadEnvFile(path.join(__dirname, ".env"));
  const app = createApp();
  app.start().then(() => {
    const a = app.server.address();
    console.log("\nFoodShare is running at http://" + app.cfg.host + ":" + a.port + "   (database: " + app.store.label + ")");
    Admin.describeAdmin(app.adminStatus, envFound).forEach((l) => console.log("  > " + l));
    console.log("");
  }).catch((e) => { console.error("failed to start:", e.message); process.exit(1); });
  const bye = (sig) => app.shutdown(sig).then(() => process.exit(0));
  process.on("SIGINT", () => bye("SIGINT")); process.on("SIGTERM", () => bye("SIGTERM"));
}
