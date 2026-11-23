"use strict";
// Create the admin account, or reset its password. Works even if an old admin already exists.
//   npm run admin
//   npm run admin -- --email you@example.com --password "Your-Passw0rd" [--disable-2fa]
const path = require("path");
const readline = require("readline");
const { loadEnvFile, getConfig } = require("../src/config");
const { Store } = require("../src/store");
const { upsertAdmin } = require("../src/admin");
loadEnvFile(path.join(__dirname, "..", ".env"));

function arg(n) { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : undefined; }
function ask(q, hidden) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { const w = rl._writeToOutput; rl._writeToOutput = function (s) { if (s.startsWith(q)) w.call(rl, s); else w.call(rl, "*"); }; }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); res(a); });
  });
}
(async () => {
  if (process.argv.includes("--help")) { console.log("Usage: npm run admin -- --email you@example.com --password \"Your-Passw0rd\" [--disable-2fa]\nPassword: 8+ characters, letters and a number, not common, must not contain your email name."); return; }
  const cfg = getConfig();
  const email = arg("email") || cfg.adminEmail || (await ask("Admin email: "));
  const password = arg("password") || cfg.adminPassword || (await ask("New admin password (hidden): ", true));
  const store = new Store(cfg, {}); await store.init();
  try {
    const action = await upsertAdmin(store, { email, password, disable2fa: process.argv.includes("--disable-2fa"), scryptN: cfg.scryptN });
    console.log(action === "created" ? "Admin account created for " + email.toLowerCase() : "Password reset for admin " + email.toLowerCase() + " (all their sessions were signed out).");
    console.log("Sign in at /#login-admin. No restart is needed.");
  } catch (e) { console.error("Could not do that: " + e.message); process.exitCode = 1; }
  await store.close();
})();
