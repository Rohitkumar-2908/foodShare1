"use strict";
// Usage: node scripts/loadtest.js http://127.0.0.1:3000/api/v1/state 2000 50
// Prints latency percentiles and status-code counts. 429s show the rate limiter working.
(async () => {
  const [url = "http://127.0.0.1:3000/api/v1/health", total = 500, conc = 20] = process.argv.slice(2);
  const lat = [], codes = {};
  let sent = 0;
  const t0 = Date.now();
  async function worker() {
    while (sent < Number(total)) {
      sent++;
      const s = process.hrtime.bigint();
      try { const r = await fetch(url); await r.arrayBuffer(); codes[r.status] = (codes[r.status] || 0) + 1; }
      catch (e) { codes.error = (codes.error || 0) + 1; }
      lat.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
  }
  await Promise.all(Array.from({ length: Number(conc) }, worker));
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
  console.log(JSON.stringify({ requests: lat.length, seconds: (Date.now() - t0) / 1000, rps: Math.round(lat.length / ((Date.now() - t0) / 1000)), p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), statusCodes: codes }, null, 2));
})();
