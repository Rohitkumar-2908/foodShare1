"use strict";
// Tiny Prometheus-format metrics (counters, histograms, gauges).
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const fmt = (labels, extra) => {
  const all = Object.assign({}, labels, extra);
  const ks = Object.keys(all);
  return ks.length ? "{" + ks.map((k) => `${k}="${esc(all[k])}"`).join(",") + "}" : "";
};
class Metrics {
  constructor() { this.c = new Map(); this.h = new Map(); this.g = []; }
  inc(name, labels = {}, v = 1) {
    const k = name + "\u0000" + fmt(labels);
    const cur = this.c.get(k) || { name, labels, v: 0 };
    cur.v += v; this.c.set(k, cur);
  }
  observe(name, labels, sec) {
    const k = name + "\u0000" + fmt(labels);
    let h = this.h.get(k);
    if (!h) { h = { name, labels, b: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.h.set(k, h); }
    BUCKETS.forEach((b, i) => { if (sec <= b) h.b[i]++; });
    h.sum += sec; h.count++;
  }
  gauge(name, fn) { this.g.push([name, fn]); }
  render() {
    const out = [];
    for (const c of this.c.values()) out.push(`${c.name}${fmt(c.labels)} ${c.v}`);
    for (const h of this.h.values()) {
      BUCKETS.forEach((b, i) => out.push(`${h.name}_bucket${fmt(h.labels, { le: b })} ${h.b[i]}`));
      out.push(`${h.name}_bucket${fmt(h.labels, { le: "+Inf" })} ${h.count}`);
      out.push(`${h.name}_sum${fmt(h.labels)} ${h.sum}`, `${h.name}_count${fmt(h.labels)} ${h.count}`);
    }
    for (const [n, fn] of this.g) { try { out.push(`${n} ${Number(fn())}`); } catch (e) { /* skip */ } }
    return out.join("\n") + "\n";
  }
}
module.exports = { Metrics };
