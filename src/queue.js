"use strict";
// In-process job queue (retries with exponential backoff, dead-letter list) and an interval scheduler.
// NOTE: not durable. Jobs in memory are lost on a crash; use Redis/BullMQ if you need durability.
class Queue {
  constructor({ log = () => {}, metrics, concurrency = 2, maxAttempts = 4, baseMs = 200 } = {}) {
    Object.assign(this, { log, metrics, conc: concurrency, max: maxAttempts, base: baseMs });
    this.h = new Map(); this.q = []; this.dead = []; this.running = 0; this.n = 0;
  }
  register(type, fn) { this.h.set(type, fn); }
  push(type, payload) { const j = { id: ++this.n, type, payload, attempts: 0, at: 0 }; this.q.push(j); this._pump(); return j.id; }
  _pump() {
    while (this.running < this.conc) {
      const now = Date.now();
      const i = this.q.findIndex((j) => j.at <= now);
      if (i < 0) break;
      const j = this.q.splice(i, 1)[0];
      this.running++; this._run(j);
    }
    // wake up when the earliest waiting retry becomes due (timers can fire slightly early, so always re-arm)
    clearTimeout(this.timer);
    const next = this.q.reduce((m, j) => Math.min(m, j.at), Infinity);
    if (next !== Infinity) { this.timer = setTimeout(() => this._pump(), Math.max(1, next - Date.now() + 2)); this.timer.unref(); }
  }
  async _run(j) {
    try {
      const fn = this.h.get(j.type);
      if (!fn) throw new Error("no handler for " + j.type);
      await fn(j.payload);
      if (this.metrics) this.metrics.inc("foodshare_jobs_total", { type: j.type, result: "ok" });
    } catch (e) {
      j.attempts++;
      if (j.attempts >= this.max) {
        this.dead.push({ id: j.id, type: j.type, error: String(e.message) });
        if (this.dead.length > 100) this.dead.shift();
        this.log("error", "job moved to dead-letter list", { job: j.type, err: e.message });
        if (this.metrics) this.metrics.inc("foodshare_jobs_total", { type: j.type, result: "dead" });
      } else {
        const wait = Math.random() * this.base * Math.pow(2, j.attempts);
        j.at = Date.now() + wait; this.q.push(j);
        if (this.metrics) this.metrics.inc("foodshare_jobs_total", { type: j.type, result: "retry" });
      }
    } finally { this.running--; this._pump(); }
  }
  depth() { return this.q.length + this.running; }
  async drain(ms) { const end = Date.now() + ms; while (this.depth() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); }
}
class Scheduler {
  constructor(log = () => {}) { this.log = log; this.t = []; }
  every(name, ms, fn) {
    let running = false; // never overlap runs of the same job
    const t = setInterval(async () => {
      if (running) return; running = true;
      try { await fn(); } catch (e) { this.log("error", "scheduled job failed", { job: name, err: e.message }); } finally { running = false; }
    }, ms);
    t.unref(); this.t.push(t);
  }
  stop() { this.t.forEach(clearInterval); this.t = []; }
}
module.exports = { Queue, Scheduler };
