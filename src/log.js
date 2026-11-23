"use strict";
// Structured (JSON) logging with automatic redaction of sensitive keys.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SENSITIVE = /pass|secret|token|hash|salt|authorization|cookie|uri|signature/i;

function redact(v, depth = 0) {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v[k], depth + 1);
  return o;
}
function makeLogger(level = "info", write) {
  const min = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
  const out = write || ((lvl, line) => (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n"));
  return function log(lvl, msg, fields) {
    if (LEVELS[lvl] < min) return;
    out(lvl, JSON.stringify(Object.assign({ ts: new Date().toISOString(), level: lvl, msg }, redact(fields || {}))));
  };
}
module.exports = { makeLogger, redact };
