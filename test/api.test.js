"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { boot } = require("./helpers");
const { verify } = require("../src/webhook");

const contact = (c, n = 1) => c.post("/api/v1/contact", { name: "Visitor", email: "v@example.org", message: "Hello there, this is message " + n });

test("health, readiness, security headers, request id and trace propagation", async () => {
  const t = await boot(); const c = t.client();
  try {
    assert.strictEqual((await c.get("/healthz")).s, 200);
    assert.strictEqual((await c.get("/readyz")).s, 200);
    const r = await c.get("/api/v1/health", { "X-Request-Id": "abc-123", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    assert.strictEqual(r.s, 200); assert.strictEqual(r.b.mode, "file"); assert.strictEqual(r.b.auth, true);
    assert.strictEqual(r.h.get("x-request-id"), "abc-123");
    assert.match(r.h.get("traceparent"), /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
    assert.match(r.h.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.strictEqual(r.h.get("x-content-type-options"), "nosniff"); assert.strictEqual(r.h.get("x-frame-options"), "DENY");
    assert.ok(!r.h.get("strict-transport-security"));
    assert.ok(!(await c.get("/api/v1/health", { "X-Forwarded-Proto": "https" })).h.get("strict-transport-security"), "forwarded proto ignored without TRUST_PROXY");
  } finally { await t.close(); }
});
test("HSTS is sent when behind a trusted HTTPS proxy", async () => {
  const t = await boot({ trustProxy: true }); const c = t.client();
  try { assert.match((await c.get("/api/v1/health", { "X-Forwarded-Proto": "https" })).h.get("strict-transport-security"), /max-age=31536000/); } finally { await t.close(); }
});
test("whole-state access is gone and unknown routes/methods return proper codes", async () => {
  const t = await boot(); const c = t.client();
  try {
    assert.strictEqual((await c.get("/api/v1/state")).s, 410);
    assert.strictEqual((await c.post("/api/v1/state", {})).s, 410);
    assert.strictEqual((await c.get("/api/state")).s, 410, "retired API version");
    assert.strictEqual((await c.get("/api/v1/nope")).s, 404);
    assert.strictEqual((await c.post("/api/v1/health", {})).s, 404, "POST not routed");
    assert.strictEqual((await c.get("/api/v1/auth/login")).s, 405);
    assert.strictEqual((await c.req("DELETE", "/")).s, 405);
  } finally { await t.close(); }
});
test("bad bodies: 400 invalid JSON, 413 too large, 415 wrong content type", async () => {
  const t = await boot(); const c = t.client();
  try {
    assert.strictEqual((await c.post("/api/v1/contact", "{not json")).s, 400);
    assert.strictEqual((await c.post("/api/v1/contact", "[1,2]")).s, 400);
    assert.strictEqual((await c.post("/api/v1/contact", { name: "x".repeat(300000), email: "a@b.co", message: "x" })).s, 413);
    const r = await fetch(t.base + "/api/v1/contact", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }); assert.strictEqual(r.status, 415);
    assert.strictEqual((await c.post("/api/v1/contact", { name: "A", email: "bad", message: "short" })).s, 422);
  } finally { await t.close(); }
});
test("rate limits: global flood gets 429 with Retry-After; auth endpoints have their own stricter limit", async () => {
  const t = await boot({ rateCapacity: 4, rateRefillPerSec: 0.01 }); const c = t.client();
  try {
    const codes = []; for (let i = 0; i < 6; i++) codes.push((await c.get("/api/v1/health")).s);
    assert.ok(codes.includes(429), codes.join(","));
    const r = await c.get("/api/v1/health"); assert.strictEqual(r.s, 429); assert.ok(Number(r.h.get("retry-after")) >= 1); assert.strictEqual(r.b.error.code, "rate_limited");
  } finally { await t.close(); }
  const t2 = await boot({ authCapacity: 3, authRefillPerSec: 0.01 }); const c2 = t2.client();
  try {
    const s = []; for (let i = 0; i < 5; i++) s.push((await c2.post("/api/v1/auth/login", { email: "x" + i + "@example.org", password: "Whatever123" })).s);
    assert.ok(s.includes(429), s.join(","));
  } finally { await t2.close(); }
});
test("static files: path traversal blocked, caching headers, ETag/304", async () => {
  const t = await boot(); const c = t.client();
  try {
    const dir = t.app.cfg.publicDir, had = fs.existsSync(path.join(dir, "index.html"));
    if (!had) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "index.html"), "<html>FoodShare</html>"); }
    const r = await c.get("/"); assert.strictEqual(r.s, 200); assert.match(r.h.get("content-type"), /text\/html; charset=utf-8/); assert.strictEqual(r.h.get("cache-control"), "no-cache");
    assert.strictEqual((await c.get("/", { "If-None-Match": r.h.get("etag") })).s, 304);
    for (const p of ["/..%2f..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2fserver.js"]) { const x = await c.get(p); assert.ok([403, 404].includes(x.s), p + " -> " + x.s); assert.ok(!String(x.b).includes("createApp")); }
    assert.strictEqual((await c.get("/%00")).s, 400);
    if (!had) fs.rmSync(path.join(dir, "index.html"));
  } finally { await t.close(); }
});
test("photos are served as images with caching headers", async () => {
  const t = await boot(); const c = t.client();
  try {
    const r = await fetch(t.base + "/img/1.jpg");
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get("content-type"), "image/jpeg");
    assert.match(r.headers.get("cache-control"), /max-age/); assert.ok((await r.arrayBuffer()).byteLength > 5000);
    assert.strictEqual((await c.get("/img/../server.js")).s === 200, false);
  } finally { await t.close(); }
});
test("metrics: protected by bearer token, Prometheus format", async () => {
  const t = await boot({ metricsToken: "s3cret-token" }); const c = t.client();
  try {
    await c.get("/api/v1/health");
    assert.strictEqual((await c.get("/metrics")).s, 401);
    assert.strictEqual((await c.get("/metrics", { Authorization: "Bearer wrong-token!" })).s, 401);
    const r = await c.get("/metrics", { Authorization: "Bearer s3cret-token" });
    assert.strictEqual(r.s, 200); assert.match(r.b, /http_requests_total\{method="GET",route="\/api\/v1\/health",status="200"\} 1/);
    assert.match(r.b, /http_request_duration_seconds_bucket/); assert.match(r.b, /foodshare_circuit_open 0/);
  } finally { await t.close(); }
});
test("webhook: signed delivery after a change, verified with a rotated secret list, no personal data", async () => {
  const got = [];
  const rx = http.createServer((req, res) => { let b = ""; req.on("data", (x) => (b += x)); req.on("end", () => { got.push({ h: req.headers, b }); res.end("ok"); }); });
  await new Promise((r) => rx.listen(0, "127.0.0.1", r));
  const t = await boot({ webhookUrl: "http://127.0.0.1:" + rx.address().port + "/hook", webhookSecrets: ["new-secret", "old-secret"], webhookAllowPrivate: true }); const c = t.client();
  try {
    await c.post("/api/v1/auth/register", { name: "Hook Test", email: "hook@example.org", password: "Str0ng-Passw0rd", role: "donor" });
    const a = await t.client().post("/api/v1/auth/login", { email: "admin@example.org", password: "Adm1n-Pass-Phrase" });
    assert.strictEqual(a.s, 200);
    const adm = t.client(); const lr = await adm.post("/api/v1/auth/login", { email: "admin@example.org", password: "Adm1n-Pass-Phrase" });
    await adm.act("profile.update", { name: "Admin", phone: "9876543210", x: [], acceptTerms: true });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(got.length >= 1);
    assert.ok(verify(["new-secret"], got[0].h["x-foodshare-timestamp"], got[0].b, got[0].h["x-foodshare-signature"]));
    assert.strictEqual(JSON.parse(got[0].b).type, "state.updated");
    assert.ok(!got[0].b.includes("hook@example.org") && !got[0].b.includes("pw"));
  } finally { await t.close(); rx.close(); }
});
test("audit log records actions through the queue", async () => {
  const t = await boot(); const c = t.client();
  try {
    await c.post("/api/v1/auth/register", { name: "Audit Me", email: "audit@example.org", password: "Str0ng-Passw0rd", role: "donor" });
    await t.app.queue.drain(2000);
    const text = fs.readFileSync(path.join(t.app.cfg.dataDir, "audit.log"), "utf8");
    assert.match(text, /"type":"auth.register"/);
  } finally { await t.close(); }
});
test("errors never leak internals", async () => {
  const t = await boot(); const c = t.client();
  try {
    t.app.store.get = async () => { throw new Error("secret connection string mongodb://u:p@h"); };
    const r = await c.get("/api/v1/view");
    assert.strictEqual(r.s, 500); assert.strictEqual(r.b.error.code, "internal_error");
    assert.ok(!JSON.stringify(r.b).includes("mongodb://")); assert.ok(r.b.error.requestId);
  } finally { await t.close(); }
});
test("MongoDB outage over HTTP: writes keep working via the file database and the circuit opens", async () => {
  const docs = new Map(); let down = false;
  const chk = () => { if (down) throw new Error("refused"); };
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const factory = async () => ({ col: {
    async findOne(q) { chk(); const d = docs.get(q._id); return d ? cl(d) : null; },
    async insertOne(d) { chk(); if (docs.has(d._id)) { const e = new Error("dup"); e.code = 11000; throw e; } docs.set(d._id, cl(d)); },
    async updateOne(q, u) { chk(); const d = docs.get(q._id); if (!d || d.rev !== q.rev) return { matchedCount: 0 }; Object.assign(d, cl(u.$set)); return { matchedCount: 1 }; },
    async replaceOne(q, d) { chk(); docs.set(q._id, cl(d)); } },
    audits: { async insertOne() { chk(); } }, close: async () => {} });
  const t = await boot({ mongoFactory: factory, breakerFailures: 1, breakerCooldownMs: 60000 }); const c = t.client();
  try {
    assert.strictEqual((await c.get("/api/v1/health")).b.mode, "mongodb");
    assert.strictEqual((await contact(c)).s, 201);
    down = true;
    const r = await contact(c, 2); assert.strictEqual(r.s, 201, "write still succeeds");
    const h = await c.get("/api/v1/health"); assert.strictEqual(h.b.circuit, "open"); assert.match(h.b.label, /MongoDB unavailable/);
    assert.match((await c.get("/metrics")).b, /foodshare_circuit_open 1/);
  } finally { await t.close(); }
});
test("readOnly flag blocks changes with 503 but sign-in still works", async () => {
  const t = await boot({ flags: new Set(["readOnly", "metrics"]) }); const c = t.client();
  try {
    assert.strictEqual((await c.post("/api/v1/auth/register", { name: "No Way", email: "ro@example.org", password: "Str0ng-Passw0rd", role: "donor" })).s, 503);
    const l = await c.post("/api/v1/auth/login", { email: "admin@example.org", password: "Adm1n-Pass-Phrase" }); assert.strictEqual(l.s, 200);
    const r = await c.act("profile.update", { name: "x" }); assert.strictEqual(r.s, 503); assert.ok(r.h.get("retry-after"));
    assert.strictEqual((await c.get("/api/v1/view")).s, 200, "reads still work");
  } finally { await t.close(); }
});
test("graceful shutdown: readiness flips, server stops, queue drains", async () => {
  const t = await boot(); let done = false;
  t.app.queue.register("slow", async () => { await new Promise((r) => setTimeout(r, 100)); done = true; });
  t.app.queue.push("slow", {});
  const p = t.app.shutdown("test");
  assert.strictEqual(t.app.state.shuttingDown, true);
  await p; assert.ok(done, "in-flight job finished before exit");
  await assert.rejects(fetch(t.base + "/healthz"), "no longer accepts connections");
});
