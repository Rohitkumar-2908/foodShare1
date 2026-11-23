"use strict";
// Timeouts, exponential backoff with jitter, circuit breaker, token-bucket rate limiter.

function withTimeout(p, ms, label = "operation") {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Exponential backoff with "full jitter": wait = random(0, min(max, base * factor^attempt)).
async function retry(fn, o = {}) {
  const { retries = 3, base = 100, max = 2000, factor = 2, jitter = true, shouldRetry = () => true,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = o;
  for (let a = 0; ; a++) {
    try { return await fn(a); }
    catch (e) {
      if (a >= retries || !shouldRetry(e)) throw e;
      const cap = Math.min(max, base * Math.pow(factor, a));
      await sleep(jitter ? Math.random() * cap : cap);
    }
  }
}

class CircuitOpenError extends Error {
  constructor(name) { super("circuit open: " + name); this.circuitOpen = true; }
}
class CircuitBreaker {
  constructor({ name = "dep", failureThreshold = 3, cooldownMs = 10000, isFailure = () => true, onOpen, onClose, now = () => Date.now() } = {}) {
    Object.assign(this, { name, threshold: failureThreshold, cooldown: cooldownMs, isFailure, onOpen, onClose, now });
    this.state = "closed"; this.failures = 0; this.openedAt = 0; this.probing = false;
  }
  async exec(fn) {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.cooldown) throw new CircuitOpenError(this.name);
      this.state = "half-open";
    }
    if (this.state === "half-open") {
      if (this.probing) throw new CircuitOpenError(this.name); // only one probe at a time
      this.probing = true;
    }
    try {
      const r = await fn();
      const was = this.state;
      this.failures = 0; this.probing = false;
      if (was !== "closed") { this.state = "closed"; if (this.onClose) this.onClose(); }
      return r;
    } catch (e) {
      this.probing = false;
      if (!this.isFailure(e)) throw e;
      this.failures++;
      if (this.state === "half-open" || this.failures >= this.threshold) {
        const was = this.state;
        this.state = "open"; this.openedAt = this.now();
        if (was === "closed" && this.onOpen) this.onOpen();
      }
      throw e;
    }
  }
}

class RateLimiter {
  constructor({ capacity, refillPerSec, now = () => Date.now(), maxKeys = 10000 }) {
    Object.assign(this, { cap: capacity, rate: refillPerSec, now, maxKeys }); this.m = new Map();
  }
  take(key) {
    const n = this.now();
    let b = this.m.get(key);
    if (!b) { if (this.m.size >= this.maxKeys) this.sweep(n, true); b = { tokens: this.cap, t: n }; this.m.set(key, b); }
    b.tokens = Math.min(this.cap, b.tokens + ((n - b.t) / 1000) * this.rate); b.t = n;
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, remaining: Math.floor(b.tokens), retryAfter: 0 }; }
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / this.rate)) };
  }
  sweep(n = this.now(), force = false) { for (const [k, b] of this.m) if (force || n - b.t > 60000) this.m.delete(k); }
}
module.exports = { withTimeout, retry, CircuitBreaker, CircuitOpenError, RateLimiter };
