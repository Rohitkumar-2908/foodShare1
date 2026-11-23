"use strict";
// Creating and recovering the admin account. Used at startup (from .env) and by `npm run admin`.
const A = require("./auth");
const D = require("./domain");
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function adminProblem(email, password) {
  if (!EMAIL_RE.test(String(email || ""))) return "The admin email must look like name@example.com.";
  return A.passwordProblem(password, email);
}
// Creates the admin, or resets the password if that email already belongs to an admin.
async function upsertAdmin(store, { email, password, disable2fa = false, scryptN = 16384 }) {
  email = String(email || "").trim().toLowerCase();
  const problem = adminProblem(email, password);
  if (problem) throw new Error(problem);
  const pw = await A.hashPassword(password, scryptN);
  let action;
  await store.update((s) => {
    const u = s.users.find((x) => x.email === email && !x.deletedAt);
    if (u && u.role !== "admin") throw new Error("That email already belongs to a " + u.role + " account. Use a different email for the admin.");
    if (u) {
      u.pw = pw; delete u.hash; delete u.salt; u.sus = false; u.ver = "verified"; if (disable2fa) u.totp = null;
      s.sessions = s.sessions.filter((x) => x.uid !== u.id); action = "reset";
    } else {
      const n = D.newUser(s, { name: "Admin", email, role: "admin", pw, now: Date.now() }); n.ver = "verified"; action = "created";
    }
    D.evt(s, "Admin account " + action + " for " + email);
  });
  return action;
}
// Decide what to do at startup and say clearly what happened.
async function bootstrapAdmin(store, cfg) {
  const env = await store.get({ fresh: true });
  const admins = env.state ? env.state.users.filter((u) => u.role === "admin" && !u.deletedAt).map((u) => u.email) : [];
  if (admins.length) return { status: cfg.adminEmail && !admins.includes(cfg.adminEmail) ? "exists-other" : "exists", emails: admins };
  if (!cfg.adminEmail || !cfg.adminPassword) return { status: "missing" };
  const problem = adminProblem(cfg.adminEmail, cfg.adminPassword);
  if (problem) return { status: "rejected", reason: problem };
  await upsertAdmin(store, { email: cfg.adminEmail, password: cfg.adminPassword, scryptN: cfg.scryptN });
  return { status: "created", email: cfg.adminEmail };
}
function describeAdmin(r, envFound) {
  const L = [];
  if (!envFound) L.push("No .env file was found. Copy .env.example to a file named exactly .env (no .txt on the end) in the project folder.");
  switch (r.status) {
    case "created": L.push("Admin account created: " + r.email + ". Sign in at /#login-admin with the ADMIN_PASSWORD from your .env."); break;
    case "exists": L.push("Admin account exists: " + r.emails.join(", ") + ". The ADMIN_PASSWORD in .env is only used the first time. To set a new password run: npm run admin"); break;
    case "exists-other": L.push("An admin already exists (" + r.emails.join(", ") + "), so ADMIN_EMAIL and ADMIN_PASSWORD from .env were ignored. Sign in with that admin, or run: npm run admin"); break;
    case "rejected": L.push("ADMIN_PASSWORD was rejected, so NO admin account was created. Reason: " + r.reason + " Fix .env and restart, or run: npm run admin"); break;
    default: L.push("No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart, or run: npm run admin");
  }
  return L;
}
module.exports = { adminProblem, upsertAdmin, bootstrapAdmin, describeAdmin };
