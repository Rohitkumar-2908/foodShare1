"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { boot, tmp, signup, PASS } = require("./helpers");
const { adminProblem, upsertAdmin, describeAdmin } = require("../src/admin");
const { createApp } = require("../server");

const login = (c, email, password) => c.post("/api/v1/auth/login", { email, password });
async function bootWith(over, preState) {
  const dir = tmp();
  if (preState) fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ rev: 1, state: preState }));
  return boot(Object.assign({ dataDir: dir }, over));
}
const legacy = () => ({ users: [{ id: 1, name: "Old Admin", email: "old-admin@example.org", role: "admin", salt: "s", hash: crypto.createHash("sha256").update("s" + "OldPass123").digest("hex"), credits: 0 }], don: [], ord: [], drv: [], log: [], msg: [], seq: 2, v: 2 });

test("admin password rules are explained, including the 'contains admin' trap", () => {
  assert.match(adminProblem("admin@example.org", "Admin@123"), /email name/);
  assert.match(adminProblem("me@example.org", "admin123"), /common/);
  assert.match(adminProblem("me@example.org", "OnlyLettersHere"), /number/);
  assert.match(adminProblem("me@example.org", "Ab1"), /8 to 128/);
  assert.match(adminProblem("not-an-email", "Str0ng-Pass-9"), /name@example.com/);
  assert.strictEqual(adminProblem("me@example.org", "Str0ng-Pass-9"), null);
});
test("a good ADMIN_EMAIL and ADMIN_PASSWORD create the admin on first start", async () => {
  const t = await bootWith({ adminEmail: "me@example.org", adminPassword: "Str0ng-Pass-9" });
  try {
    assert.strictEqual(t.app.adminStatus.status, "created");
    assert.strictEqual((await login(t.client(), "me@example.org", "Str0ng-Pass-9")).s, 200);
    assert.strictEqual((await t.client().get("/api/v1/health")).b.needsAdmin, false);
  } finally { await t.close(); }
});
test("a rejected ADMIN_PASSWORD is reported clearly, health says an admin is needed, and the CLI fixes it", async () => {
  const t = await bootWith({ adminEmail: "admin@example.org", adminPassword: "Admin@123" });
  try {
    assert.strictEqual(t.app.adminStatus.status, "rejected"); assert.match(t.app.adminStatus.reason, /email name/);
    assert.match(describeAdmin(t.app.adminStatus, true).join(" "), /NO admin account was created.*npm run admin/);
    assert.strictEqual((await login(t.client(), "admin@example.org", "Admin@123")).s, 401);
    assert.strictEqual((await t.client().get("/api/v1/health")).b.needsAdmin, true);
    await assert.rejects(upsertAdmin(t.app.store, { email: "admin@example.org", password: "Admin@123", scryptN: 1024 }), /email name/);
    assert.strictEqual(await upsertAdmin(t.app.store, { email: "admin@example.org", password: "Different-Pass-7", scryptN: 1024 }), "created");
    assert.strictEqual((await login(t.client(), "admin@example.org", "Different-Pass-7")).s, 200);
    assert.strictEqual((await t.client().get("/api/v1/health")).b.needsAdmin, false);
  } finally { await t.close(); }
});
test("an admin left over from an older version blocks .env credentials; the CLI creates or resets an admin anyway", async () => {
  const t = await bootWith({ adminEmail: "me@example.org", adminPassword: "Str0ng-Pass-9" }, legacy());
  try {
    assert.strictEqual(t.app.adminStatus.status, "exists-other"); assert.deepStrictEqual(t.app.adminStatus.emails, ["old-admin@example.org"]);
    assert.match(describeAdmin(t.app.adminStatus, true).join(" "), /old-admin@example.org.*ignored.*npm run admin/);
    assert.strictEqual((await login(t.client(), "me@example.org", "Str0ng-Pass-9")).s, 401, "the .env password is not used");
    assert.strictEqual((await login(t.client(), "old-admin@example.org", "OldPass123")).s, 200, "the old admin still works with its old password");
    assert.strictEqual(await upsertAdmin(t.app.store, { email: "me@example.org", password: "Str0ng-Pass-9", scryptN: 1024 }), "created");
    assert.strictEqual((await login(t.client(), "me@example.org", "Str0ng-Pass-9")).s, 200);
    // reset the old admin's password; the old one stops working and existing sessions end
    const live = t.client(); assert.strictEqual((await login(live, "old-admin@example.org", "OldPass123")).s, 200);
    assert.strictEqual(await upsertAdmin(t.app.store, { email: "OLD-admin@example.org", password: "Brand-New-Pass-3", scryptN: 1024 }), "reset");
    assert.strictEqual((await login(t.client(), "old-admin@example.org", "OldPass123")).s, 401);
    assert.strictEqual((await login(t.client(), "old-admin@example.org", "Brand-New-Pass-3")).s, 200);
    assert.strictEqual((await live.get("/api/v1/auth/me")).s, 401, "old sessions are signed out");
  } finally { await t.close(); }
});
test("the CLI refuses to turn a normal user into an admin and can switch off a lost 2FA", async () => {
  const t = await boot();
  try {
    await signup(t, "donor", "Regular Donor", "regular@example.org");
    await assert.rejects(upsertAdmin(t.app.store, { email: "regular@example.org", password: "Str0ng-Pass-9", scryptN: 1024 }), /already belongs to a donor/);
    const A = require("../src/auth"), c = t.client(); await login(c, "admin@example.org", "Adm1n-Pass-Phrase");
    const setup = await c.post("/api/v1/auth/totp/setup", {}); await c.post("/api/v1/auth/totp/enable", { code: A.totp(A.b32dec(setup.b.secret)) });
    assert.strictEqual((await login(t.client(), "admin@example.org", "Adm1n-Pass-Phrase")).b.needs2fa, true);
    await upsertAdmin(t.app.store, { email: "admin@example.org", password: "Adm1n-Pass-Phrase", disable2fa: true, scryptN: 1024 });
    assert.strictEqual((await login(t.client(), "admin@example.org", "Adm1n-Pass-Phrase")).s, 200);
  } finally { await t.close(); }
});
test("missing settings and a missing .env file are explained", () => {
  assert.match(describeAdmin({ status: "missing" }, false).join(" "), /No \.env file was found.*exactly \.env.*No admin account exists yet/);
  assert.match(describeAdmin({ status: "exists", emails: ["a@b.co"] }, true).join(" "), /only used the first time/);
});
test(".env parsing accepts quotes, export, CRLF and comments", () => {
  const { loadEnvFile } = require("../src/config"); const f = path.join(tmp(), ".env");
  fs.writeFileSync(f, "\uFEFF# comment\r\nexport ZZ_A=\"quoted value\"\r\nzz_b = plain\r\nZZ_C=with#hash\r\n");
  assert.strictEqual(loadEnvFile(f), true);
  assert.strictEqual(process.env.ZZ_A, "quoted value"); assert.strictEqual(process.env.zz_b, "plain"); assert.strictEqual(process.env.ZZ_C, "with#hash");
  assert.strictEqual(loadEnvFile(path.join(tmp(), "nope")), false);
  delete process.env.ZZ_A; delete process.env.zz_b; delete process.env.ZZ_C;
});
