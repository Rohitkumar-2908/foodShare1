"use strict";
// Simulates a Vercel deployment: static files from public/, vercel.json rewrites into the serverless handler,
// several "instances" (cold starts) sharing one MongoDB, no writable disk, no listening socket in the app itself.
process.env.LOG_LEVEL = "silent";
process.env.VERCEL = "1";
process.env.DATA_KEY = "ab".repeat(32);
delete process.env.MONGODB_URI;

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp, CSP } = require("../server");
const { getConfig, serverlessProblems } = require("../src/config");
const { Client } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const VJ = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const MIME = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".js": "text/javascript", ".css": "text/css" };
const HTTPS = { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" };
const ADMIN = { email: "admin@example.org", password: "Adm1n-Pass-Phrase" };

// ----- tiny Vercel emulator: filesystem first, then rewrites, rewrite keeps the original req.url -----
const toRe = (src) => new RegExp("^" + src.replace(/\/:\w+\*$/, "(?:/.*)?") + "$");
function emulator(handler) {
  const rules = VJ.rewrites.map((r) => ({ re: toRe(r.source), dest: r.destination }));
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const rel = p === "/" ? "/index.html" : p;
    const file = path.join(ROOT, VJ.outputDirectory, rel);
    if (file.startsWith(path.join(ROOT, VJ.outputDirectory)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      return fs.createReadStream(file).pipe(res);
    }
    if (rules.some((r) => r.re.test(p))) return handler(req, res);
    res.writeHead(404); res.end("NOT_FOUND");
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: "http://127.0.0.1:" + srv.address().port })));
}

function fakeMongo() {
  const docs = new Map(), f = { down: false, audits: [], connects: 0 };
  const chk = () => { if (f.down) throw new Error("connection refused"); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  f.docs = docs;
  f.factory = async () => { f.connects++; chk(); return {
    col: {
      async findOne(q) { chk(); const d = docs.get(q._id); return d ? clone(d) : null; },
      async insertOne(d) { chk(); if (docs.has(d._id)) { const e = new Error("dup"); e.code = 11000; throw e; } docs.set(d._id, clone(d)); },
      async updateOne(q, u) { chk(); const d = docs.get(q._id); if (!d || d.rev !== q.rev) return { matchedCount: 0 }; Object.assign(d, clone(u.$set)); return { matchedCount: 1 }; },
      async replaceOne(q, d) { chk(); docs.set(q._id, clone(d)); },
    },
    audits: { async insertOne(d) { chk(); await new Promise((r) => setTimeout(r, 20)); f.audits.push(d); } },
    close: async () => {},
  }; };
  return f;
}

const NODISK = path.join(os.tmpdir(), "fs-vercel-must-not-exist-" + process.pid);
// One "lambda instance": same code as api/index.js, own memory, shared MongoDB.
const instance = (fm, over = {}) => createApp(Object.assign({
  mongoUri: "mongodb://fake", mongoFactory: fm && fm.factory, dataDir: NODISK, scryptN: 1024, queueBaseMs: 5,
  adminEmail: ADMIN.email, adminPassword: ADMIN.password, mongoTimeoutMs: 300, breakerFailures: 2, breakerCooldownMs: 50,
  rateCapacity: 1e5, writeCapacity: 1e5, authCapacity: 1e5,
}, over));
const H = (c) => ({ headers: HTTPS, c });
const g = (c, p) => c.req("GET", p, undefined, HTTPS);
const po = (c, p, b) => c.req("POST", p, b, HTTPS);

test("serverless defaults: proxy trusted, no cache, throwaway data dir, small pool", () => {
  const c = getConfig();
  assert.strictEqual(c.serverless, true); assert.strictEqual(c.trustProxy, true); assert.strictEqual(c.cacheMs, 0);
  assert.ok(c.dataDir.startsWith(os.tmpdir())); assert.strictEqual(c.mongoMinPool, 0); assert.ok(c.mongoMaxPool <= 5);
});
test("serverlessProblems names exactly what is missing", () => {
  assert.deepStrictEqual(serverlessProblems({ serverless: false }), []);
  assert.deepStrictEqual(serverlessProblems({ serverless: true, mongoUri: "x" }), []);
  assert.deepStrictEqual(serverlessProblems({ serverless: true, mongoUri: "" }), ["MONGODB_URI"]);
  const k = process.env.DATA_KEY; process.env.DATA_KEY = "short";
  try { assert.deepStrictEqual(serverlessProblems({ serverless: true, mongoUri: "x" }), ["DATA_KEY (64 hex characters)"]); } finally { process.env.DATA_KEY = k; }
});

test("vercel.json is consistent with the project", () => {
  assert.strictEqual(VJ.outputDirectory, "public"); assert.ok(fs.existsSync(path.join(ROOT, "public", "index.html")));
  assert.ok(fs.existsSync(path.join(ROOT, "api", "index.js")));
  for (const k of Object.keys(VJ.functions)) assert.ok(fs.existsSync(path.join(ROOT, k)), k + " exists");
  assert.ok(VJ.functions["api/index.js"].maxDuration >= 10);
  const csp = VJ.headers.flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy");
  assert.strictEqual(csp.value, CSP, "static pages get the same CSP as the API");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.dependencies.mongodb, "mongodb is a normal dependency so Vercel always installs it"); assert.match(pkg.engines.node, /^22/);
  const ign = fs.readFileSync(path.join(ROOT, ".vercelignore"), "utf8").split(/\r?\n/);
  for (const need of ["public", "src", "api", "server.js", "package.json", "vercel.json"]) assert.ok(!ign.includes(need), need + " must not be ignored");
  // every image the page references is shipped
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const imgs = new Set(html.match(/img\/[\w.-]+\.(?:jpg|png|webp|svg)/g) || []);
  assert.ok(imgs.size > 0); for (const i of imgs) assert.ok(fs.existsSync(path.join(ROOT, "public", i)), i);
  // every API path the page calls is routed to the function
  const rules = VJ.rewrites.map((r) => toRe(r.source));
  const calls = new Set((html.match(/\/api\/v1\/[A-Za-z0-9/._-]+/g) || []));
  assert.ok(calls.size >= 8); for (const c of [...calls, "/api/v1/actions/profile.update", "/api/v1/auth/login/2fa", "/healthz", "/readyz", "/metrics"]) assert.ok(rules.some((r) => r.test(c)), c + " is rewritten");
});

test("full user journey through the emulated Vercel deployment", async () => {
  const fm = fakeMongo(), app = instance(fm), { srv, base } = await emulator(app.handler);
  try {
    const page = await fetch(base + "/"); assert.strictEqual(page.status, 200); assert.match(await page.text(), /FoodShare/);
    assert.strictEqual((await fetch(base + "/img/1.jpg")).status, 200);
    assert.strictEqual((await fetch(base + "/nope.png")).status, 404);
    const c = new Client(base);
    const h = await g(c, "/api/v1/health"); assert.strictEqual(h.s, 200);
    assert.strictEqual(h.b.auth, true); assert.strictEqual(h.b.mode, "mongodb"); assert.strictEqual(h.b.needsAdmin, false, "admin bootstrapped from env on cold start");
    assert.match(h.h.get("content-security-policy"), /default-src 'self'/);
    assert.strictEqual((await fetch(base + "/healthz")).status, 200);
    assert.strictEqual((await fetch(base + "/readyz")).status, 200);
    // register + cookie flags behind the proxy
    const r = await po(c, "/api/v1/auth/register", { name: "Green Cafe", email: "cafe@example.org", password: "Str0ng-Passw0rd", role: "donor" });
    assert.strictEqual(r.s, 201); const sc = r.h.get("set-cookie");
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Secure/, "Secure cookie because X-Forwarded-Proto is https");
    assert.ok(fm.audits.some((a) => a.type === "auth.register"), "audit job finished before the response ended (function would freeze otherwise)");
    assert.strictEqual(fm.audits.find((a) => a.type === "auth.register").ip, "203.0.113.7", "client IP comes from X-Forwarded-For");
    const v = await g(c, "/api/v1/view"); assert.strictEqual(v.s, 200); assert.strictEqual(v.b.user.email, "cafe@example.org");
    const a = await po(c, "/api/v1/actions/profile.update", { name: "Green Cafe", phone: "9876543210", area: "Dwarka", addr: "12 Test Street", x: ["Restaurant", ""], acceptTerms: true });
    assert.strictEqual(a.s, 200, JSON.stringify(a.b));
    assert.strictEqual((await po(c, "/api/v1/contact", { name: "Visitor", email: "v@example.org", message: "Hello there, nice site!" })).s, 201);
    assert.strictEqual((await po(c, "/api/v1/auth/logout", {})).s, 200);
    assert.strictEqual((await g(c, "/api/v1/view")).b.user, null);
    // admin login (needs the scrypt hash created at cold start)
    const ad = new Client(base); const l = await po(ad, "/api/v1/auth/login", ADMIN); assert.strictEqual(l.s, 200); assert.strictEqual(l.b.user.role, "admin");
    assert.ok(!fs.existsSync(NODISK), "nothing was written to disk");
  } finally { srv.close(); await app.store.close(); }
});

test("two instances share one database: a login on A is valid on B immediately (no stale cache)", async () => {
  const fm = fakeMongo(), A = instance(fm), B = instance(fm);
  const ea = await emulator(A.handler), eb = await emulator(B.handler);
  try {
    const cb0 = new Client(eb.base); assert.strictEqual((await g(cb0, "/api/v1/view")).b.user, null); // B now has seen the state
    const ca = new Client(ea.base); const reg = await po(ca, "/api/v1/auth/register", { name: "Shared User", email: "shared@example.org", password: "Str0ng-Passw0rd", role: "ngo" });
    assert.strictEqual(reg.s, 201);
    const cb = new Client(eb.base); cb.cookie = ca.cookie; cb.csrf = ca.csrf; // same browser, next request lands on instance B
    const v = await g(cb, "/api/v1/view"); assert.strictEqual(v.s, 200); assert.strictEqual(v.b.user.email, "shared@example.org", "B sees the session created on A");
    const act = await po(cb, "/api/v1/actions/profile.update", { name: "Shared User", phone: "9876543210", area: "Dwarka", addr: "12 Test Street", x: ["REG12345", "Contact Person"], acceptTerms: true });
    assert.strictEqual(act.s, 200, JSON.stringify(act.b));
    assert.strictEqual((await g(ca, "/api/v1/view")).b.user.name, "Shared User");
    // both cold starts racing to create the same admin must not break anything
    assert.strictEqual((await po(new Client(ea.base), "/api/v1/auth/login", ADMIN)).s, 200);
    assert.strictEqual((await po(new Client(eb.base), "/api/v1/auth/login", ADMIN)).s, 200);
    assert.ok(!fs.existsSync(NODISK));
  } finally { ea.srv.close(); eb.srv.close(); await A.store.close(); await B.store.close(); }
});

test("a warm instance reuses its database connection", async () => {
  const fm = fakeMongo(), app = instance(fm), { srv, base } = await emulator(app.handler);
  try { const c = new Client(base); for (let i = 0; i < 5; i++) await g(c, "/api/v1/health"); assert.strictEqual(fm.connects, 1); }
  finally { srv.close(); await app.store.close(); }
});

test("not configured (no MONGODB_URI): page still works, no errors, API explains what is missing", async () => {
  const app = instance(null, { mongoUri: "" }), { srv, base } = await emulator(app.handler);
  try {
    assert.strictEqual((await fetch(base + "/")).status, 200);
    const h = await g(new Client(base), "/api/v1/health");
    assert.strictEqual(h.s, 200, "200 so the browser console stays clean"); assert.strictEqual(h.b.auth, false, "page switches to its browser-only demo mode");
    assert.deepStrictEqual(h.b.missing, ["MONGODB_URI"]);
    const v = await g(new Client(base), "/api/v1/view"); assert.strictEqual(v.s, 503); assert.strictEqual(v.b.error.code, "not_configured"); assert.match(v.b.error.message, /MONGODB_URI/);
    assert.strictEqual((await fetch(base + "/healthz")).status, 200);
    assert.ok(!fs.existsSync(NODISK));
  } finally { srv.close(); }
});

test("DATA_KEY missing is reported the same way", async () => {
  const k = process.env.DATA_KEY; delete process.env.DATA_KEY;
  let app; try { app = instance(fakeMongo()); } finally { process.env.DATA_KEY = k; }
  const { srv, base } = await emulator(app.handler);
  try { const h = await g(new Client(base), "/api/v1/health"); assert.strictEqual(h.b.auth, false); assert.deepStrictEqual(h.b.missing, ["DATA_KEY (64 hex characters)"]); }
  finally { srv.close(); }
});

test("MongoDB unreachable: clean 503 (never a 500, never a disk fallback), recovers by itself", async () => {
  const fm = fakeMongo(); fm.down = true;
  const app = instance(fm), { srv, base } = await emulator(app.handler);
  try {
    const c = new Client(base);
    const r1 = await g(c, "/api/v1/health"); assert.strictEqual(r1.s, 503); assert.strictEqual(r1.b.error.code, "db_unavailable"); assert.ok(r1.h.get("retry-after"));
    assert.ok(!JSON.stringify(r1.b).includes("refused"), "no internals leaked");
    fm.down = false;
    assert.strictEqual((await g(c, "/api/v1/health")).s, 503, "failure is remembered briefly so a dead database is not hammered");
    await new Promise((r) => setTimeout(r, 5200));
    assert.strictEqual((await g(c, "/api/v1/health")).s, 200, "recovered");
    // outage after a successful start
    const reg = await po(c, "/api/v1/auth/register", { name: "Outage Test", email: "out@example.org", password: "Str0ng-Passw0rd", role: "donor" }); assert.strictEqual(reg.s, 201);
    fm.down = true;
    const v = await g(c, "/api/v1/view"); assert.strictEqual(v.s, 503, JSON.stringify(v.b)); assert.strictEqual(v.b.error.code, "db_unavailable");
    const w = await po(c, "/api/v1/contact", { name: "Visitor", email: "v@example.org", message: "Hello during outage" }); assert.strictEqual(w.s, 503);
    fm.down = false; await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual((await g(c, "/api/v1/view")).s, 200, "back to normal once MongoDB returns");
    assert.ok(!fs.existsSync(NODISK), "no file database was created");
  } finally { srv.close(); await app.store.close(); }
});

test("housekeeping runs lazily and removes expired sessions", async () => {
  const fm = fakeMongo(), app = instance(fm), { srv, base } = await emulator(app.handler);
  try {
    const c = new Client(base); await po(c, "/api/v1/auth/register", { name: "Old Session", email: "old@example.org", password: "Str0ng-Passw0rd", role: "donor" });
    const d = fm.docs.get("main"); d.state.sessions.forEach((s) => { s.exp = Date.now() - 1000; }); // expire everything
    await g(c, "/api/v1/health"); // warm; maintenance is not due yet
    assert.ok(fm.docs.get("main").state.sessions.length > 0);
    // pretend 11 minutes passed: the next request triggers cleanup
    const real = Date.now; Date.now = () => real() + 11 * 60000;
    try { await g(new Client(base), "/api/v1/health"); await app.queue.drain(1000); } finally { Date.now = real; }
    assert.strictEqual(fm.docs.get("main").state.sessions.length, 0);
  } finally { srv.close(); await app.store.close(); }
});

test("the real api/index.js handler loads and answers (config problems path, no Mongo driver needed)", async () => {
  const saved = process.env.DATA_KEY; delete process.env.DATA_KEY; // force the not-configured path
  delete require.cache[require.resolve("../api/index.js")];
  const handler = require("../api/index.js"); assert.strictEqual(typeof handler, "function");
  const { srv, base } = await emulator(handler);
  try {
    const h = await g(new Client(base), "/api/v1/health"); assert.strictEqual(h.s, 200); assert.strictEqual(h.b.auth, false);
    assert.strictEqual((await fetch(base + "/healthz")).status, 200);
  } finally { srv.close(); process.env.DATA_KEY = saved; }
});
