"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CircuitBreaker, retry, withTimeout, RateLimiter } = require("../src/resilience");
const { validateState } = require("../src/validate");
const { migrate, CURRENT } = require("../src/migrations");
const { Queue } = require("../src/queue");
const { sign, verify, isPrivateIp, assertSafeUrl } = require("../src/webhook");
const { Store, ConflictError } = require("../src/store");
const { makeLogger, redact } = require("../src/log");
const { secret } = require("../src/config");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fs-unit-"));
const good = () => ({ users: [], don: [], ord: [], drv: [], log: [], seq: 1 });
const cfgFor = (dir, extra) => Object.assign({ dataDir: dir, mongoUri: "", mongoTimeoutMs: 300, mongoMaxPool: 5, mongoMinPool: 0, mongoReadPref: "primary", breakerFailures: 2, breakerCooldownMs: 50, backupKeep: 3, auditTtlDays: 1 }, extra);

function fakeMongo() {
  const docs = new Map(), f = { down: false, audits: [] };
  const chk = () => { if (f.down) throw new Error("connection refused"); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  f.docs = docs;
  f.factory = async () => { chk(); return {
    col: {
      async findOne(q) { chk(); const d = docs.get(q._id); return d ? clone(d) : null; },
      async insertOne(d) { chk(); if (docs.has(d._id)) { const e = new Error("dup"); e.code = 11000; throw e; } docs.set(d._id, clone(d)); },
      async updateOne(q, u) { chk(); const d = docs.get(q._id); if (!d || d.rev !== q.rev) return { matchedCount: 0 }; Object.assign(d, clone(u.$set)); return { matchedCount: 1 }; },
      async replaceOne(q, d) { chk(); docs.set(q._id, clone(d)); },
    },
    audits: { async insertOne(d) { chk(); f.audits.push(d); } },
    close: async () => {},
  }; };
  return f;
}

test("circuit breaker opens, fails fast, then recovers via a single probe", async () => {
  let t = 0, opened = 0, closed = 0;
  const b = new CircuitBreaker({ name: "x", failureThreshold: 2, cooldownMs: 100, now: () => t, onOpen: () => opened++, onClose: () => closed++ });
  const boom = () => Promise.reject(new Error("boom"));
  await assert.rejects(b.exec(boom)); await assert.rejects(b.exec(boom));
  assert.strictEqual(b.state, "open"); assert.strictEqual(opened, 1);
  let called = false;
  await assert.rejects(b.exec(async () => { called = true; }), (e) => e.circuitOpen);
  assert.strictEqual(called, false, "fails fast without calling the dependency");
  t = 150;
  assert.strictEqual(await b.exec(async () => "ok"), "ok");
  assert.strictEqual(b.state, "closed"); assert.strictEqual(closed, 1);
});
test("circuit breaker ignores errors that are not failures (e.g. conflicts)", async () => {
  const b = new CircuitBreaker({ failureThreshold: 1, isFailure: (e) => !e.conflict });
  await assert.rejects(b.exec(() => Promise.reject(Object.assign(new Error("c"), { conflict: true }))));
  assert.strictEqual(b.state, "closed");
});
test("retry uses exponential backoff and honours shouldRetry", async () => {
  const waits = []; let n = 0;
  const r = await retry(async () => { if (++n < 4) throw new Error("x"); return "done"; }, { retries: 5, base: 100, max: 10000, jitter: false, sleep: async (ms) => waits.push(ms) });
  assert.strictEqual(r, "done"); assert.deepStrictEqual(waits, [100, 200, 400]);
  await assert.rejects(retry(async () => { throw new Error("fatal"); }, { retries: 3, shouldRetry: () => false, sleep: async () => {} }));
});
test("withTimeout rejects slow operations", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "slow"), (e) => e.code === "ETIMEDOUT");
  assert.strictEqual(await withTimeout(Promise.resolve(5), 50), 5);
});
test("rate limiter allows a burst, rejects, then refills", () => {
  let t = 0; const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
  assert.ok(rl.take("a").ok && rl.take("a").ok && rl.take("a").ok);
  const r = rl.take("a"); assert.ok(!r.ok); assert.ok(r.retryAfter >= 1);
  assert.ok(rl.take("b").ok, "keys are independent");
  t = 2000; assert.ok(rl.take("a").ok);
});
test("validateState accepts good state and rejects bad shapes", () => {
  assert.deepStrictEqual(validateState(good()), []);
  assert.ok(validateState({ ...good(), isAdmin: true }).some((e) => /unknown field/.test(e)), "mass assignment");
  assert.ok(validateState(JSON.parse('{"users":[],"don":[],"ord":[],"drv":[],"log":[],"seq":1,"x":{"__proto__":{"a":1}}}')).length > 0);
  assert.ok(validateState({ ...good(), seq: 0 }).length > 0);
  assert.ok(validateState({ ...good(), users: [{ name: "no id" }] }).length > 0);
  assert.ok(validateState({ ...good(), users: "x" }).length > 0);
  assert.ok(validateState({ ...good(), log: [{ m: "x".repeat(70000) }] }).length > 0);
  assert.ok(validateState(null).length > 0);
});
test("migrations upgrade old data and are idempotent", () => {
  const old = { users: [{ id: 1, role: "ngo", terms: 1 }], don: [{ id: 2 }], ord: [], drv: [], log: [], seq: 3 };
  const a = migrate(old);
  assert.strictEqual(a.to, CURRENT); assert.strictEqual(a.state.users[0].ver, "pending");
  assert.strictEqual(a.state.users[0].deletedAt, null); assert.deepStrictEqual(a.state.users[0].mem, { f: {}, h: [] });
  assert.deepStrictEqual(migrate(a.state).state, a.state); assert.strictEqual(migrate(a.state).applied, 0);
  assert.throws(() => migrate({ ...good(), v: 999 }));
});
test("queue retries with backoff, then dead-letters", async () => {
  const q = new Queue({ baseMs: 5, maxAttempts: 3 }); let tries = 0, ok = 0;
  q.register("flaky", async () => { if (++tries < 3) throw new Error("no"); ok++; });
  q.register("broken", async () => { throw new Error("always"); });
  q.push("flaky", {}); q.push("broken", {});
  await q.drain(2000);
  assert.strictEqual(ok, 1); assert.strictEqual(tries, 3);
  assert.strictEqual(q.dead.length, 1); assert.strictEqual(q.dead[0].type, "broken");
});
test("queue never strands a retry (regression: early timers)", async () => {
  for (let n = 0; n < 60; n++) {
    const q = new Queue({ baseMs: 3, maxAttempts: 3 }); let tries = 0, ok = 0;
    q.register("flaky", async () => { if (++tries < 3) throw new Error("no"); ok++; });
    q.push("flaky", {}); await q.drain(1000);
    assert.strictEqual(ok, 1, "run " + n); assert.strictEqual(q.depth(), 0);
  }
});
test("webhook signatures verify, support secret rotation, and SSRF guard blocks private hosts", async () => {
  const body = '{"a":1}', ts = "123";
  const sig = sign("new-secret", ts, body);
  assert.ok(verify(["new-secret", "old-secret"], ts, body, sig));
  assert.ok(verify(["old-secret", "new-secret"], ts, body, sig), "previous secrets still accepted during rotation");
  assert.ok(!verify(["other"], ts, body, sig)); assert.ok(!verify(["new-secret"], ts, '{"a":2}', sig));
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.ok(isPrivateIp(ip), ip);
  assert.ok(!isPrivateIp("93.184.216.34"));
  await assert.rejects(assertSafeUrl("http://example.com/x", false), /https/);
  await assert.rejects(assertSafeUrl("https://localhost/x", false), /not allowed/);
});
test("logger redacts secrets", () => {
  const lines = []; const log = makeLogger("info", (l, line) => lines.push(JSON.parse(line)));
  log("info", "x", { password: "p", nested: { apiToken: "t", ok: 1 }, MONGODB_URI: "mongodb://u:p@h" });
  assert.strictEqual(lines[0].password, "[redacted]"); assert.strictEqual(lines[0].nested.apiToken, "[redacted]");
  assert.strictEqual(lines[0].nested.ok, 1); assert.strictEqual(lines[0].MONGODB_URI, "[redacted]");
  assert.strictEqual(redact("plain"), "plain");
});
test("secrets can be read from NAME_FILE (Docker secrets)", () => {
  const f = path.join(tmp(), "s.txt"); fs.writeFileSync(f, "from-file\n");
  process.env.TEST_SECRET_FILE = f; assert.strictEqual(secret("TEST_SECRET"), "from-file"); delete process.env.TEST_SECRET_FILE;
  process.env.TEST_SECRET2 = "from-env"; assert.strictEqual(secret("TEST_SECRET2"), "from-env"); delete process.env.TEST_SECRET2;
});
test("store (file mode): optimistic concurrency stops lost updates", async () => {
  const s = new Store(cfgFor(tmp()), {}); await s.init();
  assert.deepStrictEqual((await s.get()).rev, 0);
  assert.strictEqual(await s.put(0, good()), 1);
  assert.strictEqual(await s.put(1, good()), 2);
  await assert.rejects(s.put(1, good()), (e) => e instanceof ConflictError && e.currentRev === 2);
  // two racing writers with the same revision: exactly one wins
  const results = await Promise.allSettled([s.put(2, good()), s.put(2, good())]);
  assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.strictEqual(results.filter((r) => r.status === "rejected").length, 1);
});
test("store: backups rotate and a backup can be restored", async () => {
  const dir = tmp(); const s = new Store(cfgFor(dir), {}); await s.init();
  await s.put(0, { ...good(), seq: 7 });
  for (let i = 0; i < 5; i++) { await s.backup(); await new Promise((r) => setTimeout(r, 5)); }
  const files = fs.readdirSync(path.join(dir, "backups")); assert.strictEqual(files.length, 3, "keeps only the newest 3");
  const first = path.join(dir, "backups", files.sort()[0]);
  await s.put(1, { ...good(), seq: 99 });
  await s.restore(first);
  assert.strictEqual((await s.get({ fresh: true })).state.seq, 7);
});
test("store: audit falls back to a file", async () => {
  const dir = tmp(); const s = new Store(cfgFor(dir), {}); await s.init();
  await s.audit({ type: "x", n: 1 });
  assert.match(fs.readFileSync(path.join(dir, "audit.log"), "utf8"), /"type":"x"/);
});
test("store: MongoDB outage falls back to file, then reconciles on recovery", async () => {
  const dir = tmp(), fm = fakeMongo();
  const s = new Store(cfgFor(dir, { mongoUri: "x" }), { mongoFactory: fm.factory }); await s.init();
  assert.strictEqual(s.mode, "mongodb");
  assert.strictEqual(await s.put(0, { ...good(), seq: 2 }), 1);
  assert.strictEqual(fm.docs.get("main").rev, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "db.json"))).rev, 1, "file mirror is written through");
  fm.down = true;
  assert.strictEqual(await s.put(1, { ...good(), seq: 3 }), 2, "write still succeeds via file");
  assert.strictEqual(await s.put(2, { ...good(), seq: 4 }), 3);
  assert.strictEqual(s.mode, "file"); assert.strictEqual(fm.docs.get("main").rev, 1, "mongo has not seen the outage writes");
  assert.strictEqual((await s.get({ fresh: true })).state.seq, 4);
  fm.down = false; await new Promise((r) => setTimeout(r, 80)); // breaker cooldown
  assert.strictEqual(await s.put(3, { ...good(), seq: 5 }), 4);
  assert.strictEqual(fm.docs.get("main").rev, 4, "mongo caught up after recovery");
  assert.strictEqual(fm.docs.get("main").state.seq, 5);
  assert.strictEqual(s.mode, "mongodb");
});
test("store: starts on the file database when MongoDB is unreachable at boot", async () => {
  const fm = fakeMongo(); fm.down = true;
  const s = new Store(cfgFor(tmp(), { mongoUri: "x" }), { mongoFactory: fm.factory }); await s.init();
  assert.strictEqual(s.mode, "file"); assert.strictEqual(await s.put(0, good()), 1);
  await s.close();
});
test("performance budget: the frontend (without photos) stays under 150 KB", () => {
  const f = path.join(__dirname, "..", "public", "index.html");
  if (fs.existsSync(f)) assert.ok(fs.statSync(f).size < 150 * 1024, "index.html is " + fs.statSync(f).size + " bytes");
});
