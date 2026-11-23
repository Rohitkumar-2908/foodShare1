"use strict";
// Versioned data migrations for the state document. Each step is idempotent.
const steps = [
  function v1(s) { // ensure all collections exist
    for (const k of ["users", "don", "ord", "drv", "log", "msg"]) if (!Array.isArray(s[k])) s[k] = [];
    if (typeof s.seq !== "number") s.seq = 1;
    return s;
  },
  function v2(s) { // assistant memory + verification status
    s.users.forEach((u) => {
      if (!u.mem) u.mem = { f: {}, h: [] };
      if (!u.mem.f) u.mem.f = {};
      if (!u.mem.h) u.mem.h = [];
      if (u.terms && !u.ver) u.ver = u.role === "admin" ? "verified" : "pending";
    });
    return s;
  },
  function v3(s) { // soft deletes
    s.users.forEach((u) => { if (u.deletedAt === undefined) u.deletedAt = null; });
    s.don.forEach((d) => { if (d.deletedAt === undefined) d.deletedAt = null; });
    return s;
  },
  function v4(s) { // server-side sessions and password-reset codes
    if (!Array.isArray(s.sessions)) s.sessions = [];
    if (!Array.isArray(s.resets)) s.resets = [];
    return s;
  },
];
const CURRENT = steps.length;
function migrate(input) {
  const s = JSON.parse(JSON.stringify(input));
  const from = Number.isInteger(s.v) ? s.v : 0;
  if (from > CURRENT) throw new Error("state was written by a newer version of FoodShare");
  for (let i = from; i < CURRENT; i++) steps[i](s);
  s.v = CURRENT;
  return { state: s, from, to: CURRENT, applied: CURRENT - from };
}
module.exports = { migrate, CURRENT };
