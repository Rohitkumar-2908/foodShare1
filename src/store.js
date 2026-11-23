"use strict";
// Storage: MongoDB first (behind a circuit breaker), local JSON file as automatic fallback.
// Writes use optimistic concurrency (revision numbers), so concurrent writers cannot silently overwrite each other.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { CircuitBreaker, withTimeout, retry } = require("./resilience");
const { migrate, CURRENT } = require("./migrations");
const { validateState } = require("./validate");

class ConflictError extends Error {
  constructor(rev) { super("revision conflict"); this.conflict = true; this.currentRev = rev; }
}
const NOPE = Symbol("mongo-unavailable");
// Thrown on serverless when MongoDB cannot be reached. There is no safe local fallback there (every instance has its own disk).
const unavailable = (why) => Object.assign(new Error("database unavailable" + (why ? ": " + why : "")), { dbUnavailable: true, status: 503, code: "db_unavailable" });

async function realMongo(cfg) {
  const mongodb = require("mongodb"); // optional dependency
  const client = new mongodb.MongoClient(cfg.mongoUri, {
    serverSelectionTimeoutMS: cfg.mongoTimeoutMs,
    maxPoolSize: cfg.mongoMaxPool, // connection pooling
    minPoolSize: cfg.mongoMinPool,
    readPreference: cfg.mongoReadPref, // "secondaryPreferred" sends reads to read replicas
  });
  await client.connect();
  const d = client.db(cfg.mongoDb);
  const audits = d.collection("audit");
  // Indexes: TTL removes old audit rows; compound index serves "events of type X, newest first".
  await audits.createIndex({ ts: 1 }, { expireAfterSeconds: cfg.auditTtlDays * 86400 });
  await audits.createIndex({ type: 1, ts: -1 });
  return { col: d.collection("state"), audits, close: () => client.close() };
}

class Store {
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.sl = !!cfg.serverless; // serverless: MongoDB only, never touch the disk
    this.cacheMs = cfg.cacheMs === undefined ? 1000 : cfg.cacheMs;
    this.log = deps.log || (() => {});
    this.metrics = deps.metrics;
    this.injected = !!deps.mongoFactory;
    this.factory = deps.mongoFactory || (() => realMongo(cfg));
    this.file = path.join(cfg.dataDir, "db.json");
    this.backupDir = path.join(cfg.dataDir, "backups");
    this.auditFile = path.join(cfg.dataDir, "audit.log");
    this.m = null; this.hasMongo = false; this.needReconcile = false;
    this.reason = "not started"; this.lock = Promise.resolve(); this.cache = null; this.started = false;
    this.breaker = new CircuitBreaker({
      name: "mongodb", failureThreshold: cfg.breakerFailures, cooldownMs: cfg.breakerCooldownMs,
      isFailure: (e) => !e.conflict,
      onOpen: () => { this.log("error", "circuit opened: MongoDB unavailable, using file database"); if (deps.onCircuitOpen) deps.onCircuitOpen(); },
      onClose: () => { this.log("info", "circuit closed: MongoDB is back"); this.needReconcile = true; },
    });
  }
  get mode() { return this.hasMongo && this.breaker.state === "closed" ? "mongodb" : "file"; }
  get label() { return this.mode === "mongodb" ? "MongoDB" : this.sl ? "MongoDB unavailable" : "Server file database (MongoDB unavailable)"; }
  info() { return { mode: this.mode, label: this.label, circuit: this.breaker.state }; }

  async init() {
    if (!this.sl) await fsp.mkdir(this.cfg.dataDir, { recursive: true });
    if (this.cfg.mongoUri || this.injected) {
      try {
        await retry(() => this._connect(), { retries: this.sl ? 1 : 2, base: 300, max: 1500 }); // exponential backoff
      } catch (e) {
        this.reason = "MongoDB connection failed: " + e.message;
        if (this.sl) throw unavailable(e.message);
        this.log("warn", "using local file database", { reason: this.reason });
        this._reconnectLater(1000);
      }
    } else {
      this.reason = "MONGODB_URI is not set";
      if (this.sl) throw unavailable(this.reason);
      this.log("warn", "using local file database", { reason: this.reason });
    }
    this.started = true;
  }
  async _connect() {
    this.m = await withTimeout(this.factory(), this.cfg.mongoTimeoutMs + 1000, "mongodb connect");
    this.hasMongo = true; this.reason = "";
    await this._reconcile();
    this.log("info", "connected to MongoDB");
  }
  _reconnectLater(delay) {
    const t = setTimeout(() => {
      this._connect().catch(() => this._reconnectLater(Math.min(delay * 2, 60000)));
    }, delay * (0.5 + Math.random() / 2));
    t.unref(); this.timer = t;
  }

  async _fileGet() {
    try { return JSON.parse(await fsp.readFile(this.file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") this.log("error", "file database unreadable", { err: e.message }); return null; }
  }
  async _fileWrite(env) {
    await fsp.mkdir(this.cfg.dataDir, { recursive: true });
    const tmp = this.file + "." + process.pid + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(env));
    await fsp.rename(tmp, this.file); // atomic replace
  }
  async _mongoGet() {
    const d = await this.m.col.findOne({ _id: "main" });
    return d ? { rev: d.rev, state: d.state } : { rev: 0, state: null };
  }
  async _viaMongo(fn) {
    if (!this.hasMongo) return NOPE;
    try { return await this.breaker.exec(() => withTimeout(Promise.resolve().then(fn), this.cfg.mongoTimeoutMs, "mongodb")); }
    catch (e) { if (e.conflict) throw e; if (this.metrics) this.metrics.inc("foodshare_db_fallback_total"); return NOPE; }
  }
  // After an outage the file mirror may hold newer writes than MongoDB. Copy the newer one over.
  async _reconcile() {
    if (this.sl) { this.needReconcile = false; this.cache = null; return; } // no file mirror on serverless
    const m = await this._mongoGet(), f = await this._fileGet();
    if (f && f.rev > m.rev) {
      await this.m.col.replaceOne({ _id: "main" }, { _id: "main", rev: f.rev, state: f.state, updatedAt: new Date() }, { upsert: true });
      this.log("info", "imported newer local data into MongoDB", { rev: f.rev });
    } else if (m.state && (!f || m.rev > f.rev)) await this._fileWrite(m);
    this.needReconcile = false; this.cache = null;
  }
  _serial(fn) { const run = this.lock.then(() => fn()); this.lock = run.catch(() => {}); return run; }

  async get({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.t < this.cacheMs) return this.cache.env;
    if (this.needReconcile && this.hasMongo) await this._viaMongo(() => this._reconcile());
    const m = await this._viaMongo(() => this._mongoGet());
    if (m === NOPE && this.sl) throw unavailable();
    const env = (m !== NOPE ? m : await this._fileGet()) || { rev: 0, state: null };
    this.cache = { t: Date.now(), env };
    return env;
  }
  async put(expectedRev, input) {
    return this._serial(async () => {
      const { state } = migrate(input);
      let rev;
      const viaM = await this._viaMongo(async () => {
        if (this.needReconcile) await this._reconcile();
        if (expectedRev === 0) {
          try { await this.m.col.insertOne({ _id: "main", rev: 1, state, updatedAt: new Date() }); }
          catch (e) { if (e && e.code === 11000) throw new ConflictError((await this._mongoGet()).rev); throw e; }
          return 1;
        }
        const r = await this.m.col.updateOne({ _id: "main", rev: expectedRev }, { $set: { rev: expectedRev + 1, state, updatedAt: new Date() } });
        if (!r.matchedCount) throw new ConflictError((await this._mongoGet()).rev);
        return expectedRev + 1;
      });
      if (viaM === NOPE && this.sl) throw unavailable();
      if (viaM !== NOPE) {
        rev = viaM;
        if (!this.sl) await this._fileWrite({ rev, state }).catch((e) => this.log("warn", "file mirror write failed", { err: e.message })); // write-through mirror
      } else {
        const cur = (await this._fileGet()) || { rev: 0 };
        if (cur.rev !== expectedRev) throw new ConflictError(cur.rev);
        rev = cur.rev + 1;
        await this._fileWrite({ rev, state });
        if (this.hasMongo) this.needReconcile = true;
      }
      this.cache = { t: Date.now(), env: { rev, state } };
      return rev;
    });
  }
  // Read-modify-write with automatic retry when another writer got in first (compare-and-set on the revision).
  // If fn throws an error with .commit = true, the changes are still saved before the error is rethrown.
  async update(fn) {
    for (let i = 0; ; i++) {
      const env = await this.get({ fresh: true });
      const base = env.state ? JSON.parse(JSON.stringify(env.state)) : require("./domain").emptyState();
      let result, pending = null;
      try { result = await fn(base); } catch (e) { if (e && e.commit) pending = e; else throw e; }
      const errs = validateState(base);
      if (errs.length) throw new Error("refusing to save invalid state: " + errs.join("; "));
      try {
        const rev = await this.put(env.rev, base);
        if (pending) throw pending;
        return { rev, result, state: base };
      } catch (e) { if (e.conflict && i < 4) continue; throw e; }
    }
  }
  async migrateOnStart() {
    const env = await this.get({ fresh: true });
    if (!env.state || env.state.v === CURRENT) return { applied: 0 };
    await this.backup();
    const r = migrate(env.state);
    await this.put(env.rev, r.state);
    this.log("info", "data migrated", { from: r.from, to: r.to });
    return r;
  }

  async backup() {
    if (this.sl) return null; // no persistent disk on serverless; use Atlas backups
    const env = await this.get({ fresh: true });
    if (!env.state) return null;
    await fsp.mkdir(this.backupDir, { recursive: true });
    const f = path.join(this.backupDir, "db-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    await fsp.writeFile(f, JSON.stringify(env));
    const files = (await fsp.readdir(this.backupDir)).filter((n) => /^db-.*\.json$/.test(n)).sort();
    for (const n of files.slice(0, Math.max(0, files.length - this.cfg.backupKeep))) await fsp.unlink(path.join(this.backupDir, n));
    return f;
  }
  async restore(file) {
    const raw = JSON.parse(await fsp.readFile(file, "utf8"));
    const state = raw && raw.state ? raw.state : raw;
    const errs = validateState(migrate(state).state);
    if (errs.length) throw new Error("backup is not valid: " + errs.join("; "));
    const cur = await this.get({ fresh: true });
    return this.put(cur.rev, state);
  }
  async audit(evt) {
    const rec = Object.assign({ ts: new Date() }, evt);
    const r = await this._viaMongo(() => this.m.audits.insertOne(Object.assign({}, rec)));
    if (r === NOPE) {
      if (this.sl) throw unavailable(); // let the job queue retry instead of writing to a throwaway disk
      await fsp.mkdir(this.cfg.dataDir, { recursive: true });
      try { if ((await fsp.stat(this.auditFile)).size > 5e6) await fsp.rename(this.auditFile, this.auditFile + ".1"); } catch (e) { /* none yet */ }
      await fsp.appendFile(this.auditFile, JSON.stringify(Object.assign({}, rec, { ts: rec.ts.toISOString() })) + "\n");
    }
  }
  async close() { if (this.timer) clearTimeout(this.timer); try { if (this.m) await this.m.close(); } catch (e) { /* ignore */ } }
}
module.exports = { Store, ConflictError };
