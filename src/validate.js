"use strict";
// Server-side validation of the state document. Never trust the browser.
const ALLOWED = new Set(["users", "don", "ord", "drv", "log", "msg", "sessions", "resets", "seq", "at", "v"]);
const MAXLEN = { users: 5000, don: 20000, ord: 50000, drv: 5000, log: 500, msg: 2000, sessions: 20000, resets: 5000 };
const REQUIRED = ["users", "don", "ord", "drv", "log"];
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]); // prototype pollution

function deep(v, depth, p, errs) {
  if (errs.length > 5) return;
  if (depth > 8) { errs.push(p + ": nested too deeply"); return; }
  if (typeof v === "string") { if (v.length > 60000) errs.push(p + ": string too long"); return; }
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { if (!Number.isFinite(v)) errs.push(p + ": invalid number"); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => deep(x, depth + 1, p + "[" + i + "]", errs)); return; }
  if (typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN.has(k)) { errs.push(p + ": forbidden key " + k); continue; }
      deep(v[k], depth + 1, p + "." + k, errs);
    }
    return;
  }
  errs.push(p + ": unsupported type");
}
function validateState(s) {
  const errs = [];
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["state must be an object"];
  for (const k of Object.keys(s)) if (!ALLOWED.has(k)) errs.push("unknown field: " + k); // mass-assignment guard
  for (const k of REQUIRED) if (!Array.isArray(s[k])) errs.push(k + " must be an array");
  for (const k of Object.keys(MAXLEN)) {
    if (Array.isArray(s[k]) && s[k].length > MAXLEN[k]) errs.push(k + " has too many items");
    if (s[k] !== undefined && !Array.isArray(s[k])) errs.push(k + " must be an array");
  }
  for (const k of ["users", "don", "ord", "drv", "sessions", "resets"]) {
    if (Array.isArray(s[k]) && s[k].some((x) => !x || typeof x !== "object" || !Number.isInteger(x.id))) errs.push(k + ": every item needs an integer id");
  }
  if (!Number.isInteger(s.seq) || s.seq < 1) errs.push("seq must be a positive integer");
  if (s.at !== undefined && !Number.isFinite(s.at)) errs.push("at must be a number");
  if (s.v !== undefined && !Number.isInteger(s.v)) errs.push("v must be an integer");
  deep(s, 0, "state", errs);
  return errs.slice(0, 8);
}
module.exports = { validateState };
