"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { boot, signup, complete, adminClient, PASS, PX } = require("./helpers");
const A = require("../src/auth");
const D = require("../src/domain");

const DON = (extra) => Object.assign({ title: "Rice and dal", cat: "cooked", diet: "veg", qty: 20, age: 1, storage: "cold", area: "Dwarka", addr: "1 Donor Road" }, extra);
const OK = [true, true, true, true];

async function world(t, qty = 20) {
  const admin = await adminClient(t);
  const made = await admin.act("admin.createInspector", { name: "Inspector One", email: "insp@example.org" });
  const ins = t.client();
  assert.strictEqual((await ins.post("/api/v1/auth/reset", { token: made.b.result.token, password: PASS })).s, 200);
  const li = await ins.post("/api/v1/auth/login", { email: "insp@example.org", password: PASS }); assert.strictEqual(li.s, 200); ins.id = li.b.user.id;
  await complete(ins, "inspector");
  const donor = await signup(t, "donor", "Donor One"); await complete(donor, "donor");
  const ngo = await signup(t, "ngo", "Ngo One"); await complete(ngo, "ngo"); await admin.act("user.verify", { id: ngo.id });
  const dist = await signup(t, "distributor", "Dist One"); await complete(dist, "distributor"); await admin.act("user.verify", { id: dist.id });
  const d = await donor.act("donation.create", DON({ qty }));
  assert.strictEqual((await ins.act("quality.pass", { id: d.b.result.id, checks: OK, temp: 70, note: "fine" })).s, 200);
  return { admin, ins, donor, ngo, dist, don: d.b.result.id };
}

test("public view exposes no personal data and no actions work without a session", async () => {
  const t = await boot();
  try {
    const c = t.client(); await signup(t, "donor", "Public Donor");
    const r = await c.get("/api/v1/view");
    assert.strictEqual(r.s, 200); assert.strictEqual(r.b.user, null);
    assert.ok(!JSON.stringify(r.b).includes("@example.org"), "no emails");
    assert.deepStrictEqual(r.b.view.don, []); assert.deepStrictEqual(r.b.view.ord, []); assert.deepStrictEqual(r.b.view.msg, []);
    assert.ok(r.b.view.users.every((u) => !("email" in u) && !("phone" in u)));
    assert.strictEqual((await c.act("donation.create", DON())).s, 401);
    assert.strictEqual((await c.post("/api/v1/auth/logout", {})).s, 200);
  } finally { await t.close(); }
});
test("registration: roles, password policy, duplicates, secrets never returned, cookie flags", async () => {
  const t = await boot(); const c = t.client();
  try {
    const reg = (b) => c.post("/api/v1/auth/register", Object.assign({ name: "Reg Test", email: "reg@example.org", password: PASS, role: "donor" }, b));
    assert.strictEqual((await reg({ role: "admin" })).s, 422, "cannot self-register as admin");
    assert.strictEqual((await reg({ role: "inspector" })).s, 422, "cannot self-register as inspector");
    assert.strictEqual((await reg({ role: "root" })).s, 422);
    assert.strictEqual((await reg({ password: "short1" })).s, 422);
    assert.strictEqual((await reg({ password: "onlyletters" })).s, 422);
    assert.strictEqual((await reg({ password: "password123" })).s, 422, "common password");
    assert.strictEqual((await reg({ email: "nope" })).s, 422);
    const ok = await reg({}); assert.strictEqual(ok.s, 201);
    assert.match(c.setCookie, /HttpOnly/); assert.match(c.setCookie, /SameSite=Strict/); assert.match(c.setCookie, /Path=\//); assert.ok(!/Secure/.test(c.setCookie), "no Secure flag on plain http");
    assert.ok(!/"(pw|hash|salt|totp)"/.test(JSON.stringify(ok.b)), "no secrets in the response");
    assert.strictEqual(ok.b.user.role, "donor"); assert.strictEqual(ok.b.user.credits, 0);
    assert.strictEqual((await reg({})).s, 409, "duplicate email");
    assert.strictEqual((await reg({ email: "REG@example.org" })).s, 409, "email is case-insensitive");
  } finally { await t.close(); }
  const t2 = await boot({ trustProxy: true }); const c2 = t2.client();
  try { await c2.post("/api/v1/auth/register", { name: "Sec Test", email: "s@example.org", password: PASS, role: "donor" }, { "X-Forwarded-Proto": "https" }); assert.match(c2.setCookie, /Secure/); } finally { await t2.close(); }
});
test("login: generic errors, account lockout, session fixation, logout and suspension", async () => {
  const t = await boot(); const c = t.client();
  try {
    await signup(t, "donor", "Login Test", "lt@example.org");
    const bad = await c.post("/api/v1/auth/login", { email: "lt@example.org", password: "Wrong-Pass1" });
    const unknown = await c.post("/api/v1/auth/login", { email: "nobody@example.org", password: "Wrong-Pass1" });
    assert.strictEqual(bad.s, 401); assert.strictEqual(unknown.s, 401); assert.strictEqual(bad.b.error.message, unknown.b.error.message, "no user enumeration");
    const codes = []; for (let i = 0; i < 4; i++) codes.push((await c.post("/api/v1/auth/login", { email: "lt@example.org", password: "Wrong-Pass1" })).s);
    const locked = await c.post("/api/v1/auth/login", { email: "lt@example.org", password: PASS });
    assert.strictEqual(locked.s, 429, "locked even with the right password: " + codes.join(","));
    assert.ok(Number(locked.h.get("retry-after")) > 0);
  } finally { await t.close(); }
  const t2 = await boot();
  try {
    const u = await signup(t2, "donor", "Sess Test", "st@example.org");
    const attacker = "fs_sid=attackerchosentoken"; const c = t2.client(); c.cookie = attacker;
    const r = await c.post("/api/v1/auth/login", { email: "st@example.org", password: PASS }); assert.strictEqual(r.s, 200);
    assert.notStrictEqual(c.cookie, attacker, "new session id issued at login (fixation protection)");
    const old = c.cookie; const fix = t2.client(); fix.cookie = attacker; assert.strictEqual((await fix.get("/api/v1/view")).b.user, null);
    assert.strictEqual((await c.get("/api/v1/auth/me")).s, 200);
    await c.post("/api/v1/auth/logout", {});
    const stale = t2.client(); stale.cookie = old; assert.strictEqual((await stale.get("/api/v1/auth/me")).s, 401, "logout invalidates the session on the server");
    const admin = await adminClient(t2);
    const live = t2.client(); await live.post("/api/v1/auth/login", { email: "st@example.org", password: PASS });
    assert.strictEqual((await live.get("/api/v1/auth/me")).s, 200);
    assert.strictEqual((await admin.act("user.suspend", { id: u.id })).s, 200);
    assert.strictEqual((await live.get("/api/v1/auth/me")).s, 401, "suspended users lose their session");
    const again = await t2.client().post("/api/v1/auth/login", { email: "st@example.org", password: PASS }); assert.strictEqual(again.s, 403); assert.strictEqual(again.b.error.code, "suspended");
  } finally { await t2.close(); }
});
test("CSRF: state-changing calls need the token and a same-origin Origin header", async () => {
  const t = await boot();
  try {
    const c = await signup(t, "donor", "Csrf Test"); const token = c.csrf;
    c.csrf = ""; let r = await c.act("donation.create", DON(), { "x-csrf-token": "" }); assert.strictEqual(r.s, 403); assert.strictEqual(r.b.error.code, "csrf");
    r = await c.act("donation.create", DON(), { "x-csrf-token": "wrong-token-value" }); assert.strictEqual(r.s, 403);
    c.csrf = token;
    r = await c.act("donation.create", DON(), { Origin: "https://evil.example" }); assert.strictEqual(r.s, 403); assert.strictEqual(r.b.error.code, "bad_origin");
    r = await c.act("donation.create", DON(), { Origin: t.base }); assert.strictEqual(r.s, 200);
    assert.strictEqual((await c.post("/api/v1/auth/logout", {}, { "x-csrf-token": "bad" })).s, 403);
  } finally { await t.close(); }
});
test("role-based access: wrong role gets 403, role escalation and mass assignment fail", async () => {
  const t = await boot();
  try {
    const w = await world(t);
    for (const [who, act, body] of [[w.donor, "quality.pass", { id: w.don, checks: OK, temp: 70 }], [w.donor, "order.create", { donation: w.don, qty: 1, needed: 1 }], [w.ngo, "donation.create", DON()], [w.ngo, "delivery.accept", { id: 1 }], [w.dist, "user.verify", { id: w.ngo.id }], [w.ngo, "user.suspend", { id: w.donor.id }], [w.ins, "admin.createInspector", { name: "Evil One", email: "e@example.org" }], [w.ins, "user.reset", { id: w.ngo.id }], [w.donor, "admin.message.delete", { id: 1 }], [w.dist, "drive.create", { name: "Drive", date: "2026-12-31", needed: 5 }]]) {
      const r = await who.act(act, body); assert.strictEqual(r.s, 403, act + " -> " + r.s);
    }
    const r = await w.donor.act("donation.create", DON({ donor: w.ngo.id, q: { s: "passed" }, rem: 9999, role: "admin" }));
    const v = (await w.donor.get("/api/v1/view")).b.view; const mine = v.don.find((d) => d.id === r.b.result.id);
    assert.strictEqual(mine.donor, w.donor.id, "owner cannot be set by the client"); assert.strictEqual(mine.q.s, "pending", "approval cannot be set by the client"); assert.strictEqual(mine.rem, 20);
    assert.strictEqual((await w.donor.act("nope.nothing", {})).s, 404);
  } finally { await t.close(); }
});
test("ownership (IDOR): users cannot touch each other's donations or orders", async () => {
  const t = await boot();
  try {
    const w = await world(t);
    const donorB = await signup(t, "donor", "Donor Two"); await complete(donorB, "donor");
    const ngoB = await signup(t, "ngo", "Ngo Two"); await complete(ngoB, "ngo"); await w.admin.act("user.verify", { id: ngoB.id });
    assert.strictEqual((await donorB.act("donation.update", { id: w.don, qty: 5 })).s, 404);
    assert.strictEqual((await donorB.act("donation.delete", { id: w.don })).s, 404);
    const o = await w.ngo.act("order.create", { donation: w.don, qty: 5, needed: 10 }); assert.strictEqual(o.s, 200);
    assert.strictEqual((await ngoB.act("order.cancel", { id: o.b.result.id })).s, 404);
    assert.strictEqual((await ngoB.act("order.receive", { id: o.b.result.id })).s, 404);
    const dist2 = await signup(t, "distributor", "Dist Two"); await complete(dist2, "distributor"); await w.admin.act("user.verify", { id: dist2.id });
    await w.dist.act("delivery.accept", { id: o.b.result.id });
    assert.strictEqual((await dist2.act("delivery.pickup", { id: o.b.result.id, code: "1234" })).s, 404, "another distributor cannot use the order");
    const free = await ngoB.act("order.create", { donation: w.don, qty: 1, needed: 1, drive: 1 }); assert.strictEqual(free.s, 403, "cannot attach orders to a drive you don't own");
  } finally { await t.close(); }
});
test("verification gate, quality gate and the full delivery flow with credits", async () => {
  const t = await boot();
  try {
    const admin = await adminClient(t);
    const made = await admin.act("admin.createInspector", { name: "Inspector Two", email: "i2@example.org" });
    const ins = t.client(); await ins.post("/api/v1/auth/reset", { token: made.b.result.token, password: PASS }); await ins.post("/api/v1/auth/login", { email: "i2@example.org", password: PASS }); await complete(ins, "inspector");
    const donor = await signup(t, "donor", "Flow Donor"); await complete(donor, "donor");
    const ngo = await signup(t, "ngo", "Flow Ngo"); await complete(ngo, "ngo");
    const dist = await signup(t, "distributor", "Flow Dist"); await complete(dist, "distributor");
    const d = (await donor.act("donation.create", DON({ qty: 10 }))).b.result.id;
    assert.strictEqual((await ngo.act("order.create", { donation: d, qty: 5, needed: 10 })).b.error.code, "not_verified");
    await admin.act("user.verify", { id: ngo.id }); await admin.act("user.verify", { id: dist.id });
    assert.strictEqual((await ngo.act("order.create", { donation: d, qty: 5, needed: 10 })).b.error.code, "not_approved", "food must pass the quality test first");
    assert.strictEqual((await ins.act("quality.pass", { id: d, checks: [true, true, false, true], temp: 70 })).s, 422);
    assert.strictEqual((await ins.act("quality.pass", { id: d, checks: OK, temp: 30 })).s, 422, "unsafe temperature zone");
    assert.strictEqual((await ins.act("quality.pass", { id: d, checks: OK, temp: 70 })).s, 200);
    assert.strictEqual((await ngo.act("order.create", { donation: d, qty: 50, needed: 50 })).b.error.code, "not_enough");
    assert.strictEqual((await ngo.act("order.create", { donation: d, qty: 5, needed: 2 })).s, 422, "needed must cover the quantity");
    const o = (await ngo.act("order.create", { donation: d, qty: 5, needed: 10 })).b.result.id;
    assert.strictEqual((await dist.act("delivery.accept", { id: o })).s, 200);
    assert.strictEqual((await dist.act("delivery.accept", { id: o })).s, 409, "already taken");
    const code = (await donor.get("/api/v1/view")).b.view.ord.find((x) => x.id === o).otp;
    assert.match(code, /^\d{4}$/, "donor can see the pickup code");
    assert.ok(!("otp" in (await ngo.get("/api/v1/view")).b.view.ord.find((x) => x.id === o)), "requester cannot see the code");
    assert.ok(!("otp" in (await dist.get("/api/v1/view")).b.view.ord.find((x) => x.id === o)), "distributor cannot see the code");
    assert.ok(!("otp" in (await admin.get("/api/v1/view")).b.view.ord.find((x) => x.id === o)), "not even the admin");
    const wrong = code === "0000" ? "1111" : "0000";
    assert.strictEqual((await dist.act("delivery.pickup", { id: o, code: wrong })).s, 403);
    assert.strictEqual((await ngo.act("order.receive", { id: o })).s, 409, "cannot receive before pickup");
    assert.strictEqual((await dist.act("delivery.pickup", { id: o, code })).s, 200);
    const rec = await ngo.act("order.receive", { id: o }); assert.strictEqual(rec.s, 200);
    const me = (await dist.get("/api/v1/auth/me")).b.user; assert.strictEqual(me.credits, 11, "10 + ceil(5/10)");
    assert.strictEqual((await donor.get("/api/v1/auth/me")).b.user.credits, 5 + 1, "5 for passing + floor(5/5)");
    assert.strictEqual((await t.client().get("/api/v1/view")).b.view.stats.delivered, 5);
  } finally { await t.close(); }
});
test("pickup code brute force is locked out", async () => {
  const t = await boot();
  try {
    const w = await world(t);
    const o = (await w.ngo.act("order.create", { donation: w.don, qty: 5, needed: 5 })).b.result.id; await w.dist.act("delivery.accept", { id: o });
    const code = (await w.donor.get("/api/v1/view")).b.view.ord.find((x) => x.id === o).otp, wrong = code === "0000" ? "1111" : "0000";
    const s = []; for (let i = 0; i < 5; i++) s.push((await w.dist.act("delivery.pickup", { id: o, code: wrong })).s);
    assert.deepStrictEqual(s, [403, 403, 403, 403, 403]);
    const locked = await w.dist.act("delivery.pickup", { id: o, code }); assert.strictEqual(locked.s, 429, "even the right code is refused while locked"); assert.ok(Number(locked.h.get("retry-after")) > 0);
  } finally { await t.close(); }
});
test("race condition: two NGOs ordering the last meals, exactly one wins", async () => {
  const t = await boot();
  try {
    const w = await world(t, 10);
    const ngoB = await signup(t, "ngo", "Ngo Rival"); await complete(ngoB, "ngo"); await w.admin.act("user.verify", { id: ngoB.id });
    const rs = await Promise.all([w.ngo.act("order.create", { donation: w.don, qty: 10, needed: 10 }), ngoB.act("order.create", { donation: w.don, qty: 10, needed: 10 })]);
    assert.deepStrictEqual(rs.map((r) => r.s).sort(), [200, 409]);
    const total = (await w.admin.get("/api/v1/view")).b.view.ord.filter((o) => o.s === "placed").reduce((a, o) => a + o.qty, 0);
    assert.strictEqual(total, 10, "never more meals ordered than exist");
    const rem = (await w.admin.get("/api/v1/view")).b.view.don.find((d) => d.id === w.don).rem; assert.strictEqual(rem, 0);
  } finally { await t.close(); }
});
test("row-level views: every role only receives the data it may see", async () => {
  const t = await boot();
  try {
    const w = await world(t);
    const donorB = await signup(t, "donor", "Donor Private"); await complete(donorB, "donor");
    const priv = (await donorB.act("donation.create", DON({ title: "Secret pending dish", addr: "9 Private Lane" }))).b.result.id;
    const o = (await w.ngo.act("order.create", { donation: w.don, qty: 5, needed: 5 })).b.result.id;
    const ngoView = (await w.ngo.get("/api/v1/view")).b.view, distView = (await w.dist.get("/api/v1/view")).b.view;
    assert.ok(!(await donorB.get("/api/v1/view")).b.view.don.some((d) => d.id === w.don), "donor B cannot see donor A's donations");
    assert.ok(!ngoView.don.some((d) => d.id === priv), "NGOs only see approved food");
    assert.deepStrictEqual(ngoView.log, []); assert.deepStrictEqual(ngoView.msg, []); assert.ok(ngoView.users.filter((u) => u.id !== w.ngo.id).every((u) => !("email" in u) && !("phone" in u)));
    const open = distView.don.find((d) => d.id === w.don); assert.strictEqual(open.addr, "", "pickup address hidden until the delivery is accepted");
    assert.ok(distView.users.filter((u) => u.id !== w.dist.id).every((u) => !("phone" in u) && !("addr" in u)), "no contact details before accepting");
    await w.dist.act("delivery.accept", { id: o });
    const after = (await w.dist.get("/api/v1/view")).b.view;
    assert.strictEqual(after.don.find((d) => d.id === w.don).addr, "1 Donor Road"); assert.ok(after.users.some((u) => u.id === w.donor.id && u.phone === "9876543210"), "contact details shared after accepting");
    assert.ok(!after.don.some((d) => d.id === priv));
    const insView = (await w.ins.get("/api/v1/view")).b.view; assert.ok(insView.don.some((d) => d.id === priv)); assert.ok(insView.log.length > 0); assert.deepStrictEqual(insView.msg, []);
    assert.ok(insView.users.filter((u) => u.id !== w.ins.id).every((u) => !("pw" in u) && !("mem" in u) && !("totp" in u) && !("hash" in u)), "staff never see other users' private fields or secrets");
    const self = (await w.donor.get("/api/v1/view")).b.view.users.find((u) => u.id === w.donor.id); assert.ok(self.email && self.mem);
  } finally { await t.close(); }
});
test("contact form reaches the admin inbox only", async () => {
  const t = await boot();
  try {
    const c = t.client();
    assert.strictEqual((await c.post("/api/v1/contact", { name: "Visitor", email: "v@example.org", message: "I would like to partner with you" })).s, 201);
    const admin = await adminClient(t), donor = await signup(t, "donor", "Not Admin");
    assert.strictEqual((await admin.get("/api/v1/view")).b.view.msg.length, 1);
    assert.deepStrictEqual((await donor.get("/api/v1/view")).b.view.msg, []);
    const id = (await admin.get("/api/v1/view")).b.view.msg[0].id;
    assert.strictEqual((await donor.act("admin.message.delete", { id })).s, 403);
    assert.strictEqual((await admin.act("admin.message.delete", { id })).s, 200);
  } finally { await t.close(); }
});
test("two-factor authentication: setup, login step 2, wrong codes, recovery codes are single use", async () => {
  const t = await boot();
  try {
    const c = await signup(t, "donor", "Totp Test", "totp@example.org");
    const setup = await c.post("/api/v1/auth/totp/setup", {}); assert.strictEqual(setup.s, 200); assert.match(setup.b.otpauth, /^otpauth:\/\/totp\/FoodShare:/);
    assert.strictEqual((await c.post("/api/v1/auth/totp/enable", { code: "000000" })).s, 422);
    const en = await c.post("/api/v1/auth/totp/enable", { code: A.totp(A.b32dec(setup.b.secret)) }); assert.strictEqual(en.s, 200); assert.strictEqual(en.b.recoveryCodes.length, 8);
    assert.strictEqual((await c.get("/api/v1/auth/me")).b.user.totpOn, true);
    const stored = JSON.stringify(t.app.store.cache && t.app.store.cache.env.state); assert.ok(!stored.includes(setup.b.secret), "TOTP secret is encrypted at rest");
    await c.post("/api/v1/auth/logout", {});
    const l1 = t.client(); const r1 = await l1.post("/api/v1/auth/login", { email: "totp@example.org", password: PASS });
    assert.strictEqual(r1.s, 200); assert.strictEqual(r1.b.needs2fa, true); assert.ok(!l1.cookie, "no session until the second step"); assert.ok(!r1.b.view);
    assert.strictEqual((await l1.post("/api/v1/auth/login/2fa", { ticket: r1.b.ticket, code: "123456" })).s, 401);
    assert.strictEqual((await l1.post("/api/v1/auth/login/2fa", { ticket: "forged.ticket", code: A.totp(A.b32dec(setup.b.secret)) })).s, 401);
    const r2 = await l1.post("/api/v1/auth/login/2fa", { ticket: r1.b.ticket, code: A.totp(A.b32dec(setup.b.secret)) }); assert.strictEqual(r2.s, 200); assert.ok(l1.cookie);
    const rc = en.b.recoveryCodes[0];
    const l2 = t.client(); const t2 = await l2.post("/api/v1/auth/login", { email: "totp@example.org", password: PASS });
    assert.strictEqual((await l2.post("/api/v1/auth/login/2fa", { ticket: t2.b.ticket, code: rc })).s, 200);
    const l3 = t.client(); const t3 = await l3.post("/api/v1/auth/login", { email: "totp@example.org", password: PASS });
    assert.strictEqual((await l3.post("/api/v1/auth/login/2fa", { ticket: t3.b.ticket, code: rc })).s, 401, "recovery code already used");
    assert.strictEqual((await l1.post("/api/v1/auth/totp/disable", { password: "Wrong-Pass1", code: A.totp(A.b32dec(setup.b.secret)) })).s, 403);
    assert.strictEqual((await l1.post("/api/v1/auth/totp/disable", { password: PASS, code: A.totp(A.b32dec(setup.b.secret)) })).s, 200);
  } finally { await t.close(); }
});
test("password reset codes are single use and kill existing sessions; password change revokes other sessions", async () => {
  const t = await boot();
  try {
    const admin = await adminClient(t), donor = await signup(t, "donor", "Reset Test", "reset@example.org");
    const tok = (await admin.act("user.reset", { id: donor.id })).b.result.token;
    assert.strictEqual((await t.client().post("/api/v1/auth/reset", { token: tok, password: "weak" })).s, 422);
    assert.strictEqual((await t.client().post("/api/v1/auth/reset", { token: "not-a-token", password: "N3w-Passw0rd-x" })).s, 400);
    assert.strictEqual((await t.client().post("/api/v1/auth/reset", { token: tok, password: "N3w-Passw0rd-x" })).s, 200);
    assert.strictEqual((await t.client().post("/api/v1/auth/reset", { token: tok, password: "An0ther-Passw0rd" })).s, 400, "single use");
    assert.strictEqual((await donor.get("/api/v1/auth/me")).s, 401, "old session revoked");
    assert.strictEqual((await t.client().post("/api/v1/auth/login", { email: "reset@example.org", password: PASS })).s, 401, "old password stops working");
    const a = t.client(), b = t.client();
    await a.post("/api/v1/auth/login", { email: "reset@example.org", password: "N3w-Passw0rd-x" }); await b.post("/api/v1/auth/login", { email: "reset@example.org", password: "N3w-Passw0rd-x" });
    assert.strictEqual((await a.post("/api/v1/auth/password", { current: "wrong-one-123", next: "Y3t-Another-Pass" })).s, 403);
    assert.strictEqual((await a.post("/api/v1/auth/password", { current: "N3w-Passw0rd-x", next: "Y3t-Another-Pass" })).s, 200);
    assert.strictEqual((await a.get("/api/v1/auth/me")).s, 200, "this session stays"); assert.strictEqual((await b.get("/api/v1/auth/me")).s, 401, "other sessions revoked");
  } finally { await t.close(); }
});
test("old SHA-256 password hashes are upgraded to scrypt on first login", async () => {
  const t = await boot();
  try {
    await t.app.store.update((s) => { const u = D.newUser(s, { name: "Legacy User", email: "legacy@example.org", role: "donor", pw: null, now: Date.now() }); u.salt = "abc123"; u.hash = A.sha256("abc123" + "Legacy-Pass1"); });
    assert.strictEqual((await t.client().post("/api/v1/auth/login", { email: "legacy@example.org", password: "wrong-Pass1" })).s, 401);
    assert.strictEqual((await t.client().post("/api/v1/auth/login", { email: "legacy@example.org", password: "Legacy-Pass1" })).s, 200);
    const u = (await t.app.store.get({ fresh: true })).state.users.find((x) => x.email === "legacy@example.org");
    assert.strictEqual(u.pw.alg, "scrypt"); assert.ok(!u.hash && !u.salt);
  } finally { await t.close(); }
});
test("account deletion erases personal data; data export has no secrets", async () => {
  const t = await boot();
  try {
    const admin = await adminClient(t), donor = await signup(t, "donor", "Erase Me", "erase@example.org"); await complete(donor, "donor");
    await donor.act("donation.create", DON());
    const ex = await donor.act("account.export", {}); assert.strictEqual(ex.s, 200); assert.strictEqual(ex.b.result.donations.length, 1); assert.ok(!/"(pw|hash|salt)"/.test(JSON.stringify(ex.b.result)));
    assert.strictEqual((await donor.act("account.delete", {})).s, 200);
    assert.strictEqual((await donor.get("/api/v1/auth/me")).s, 401);
    assert.strictEqual((await t.client().post("/api/v1/auth/login", { email: "erase@example.org", password: PASS })).s, 401);
    const gone = (await admin.get("/api/v1/view")).b.view.users.find((u) => u.id === donor.id);
    assert.strictEqual(gone.name, "Deleted user"); assert.strictEqual(gone.phone, ""); assert.ok(!JSON.stringify(gone).includes("erase@example.org"));
    assert.strictEqual((await admin.act("account.delete", {})).s, 403, "the admin account cannot delete itself");
  } finally { await t.close(); }
});
test("profile photos must be real JPEGs of limited size; profile input is validated", async () => {
  const t = await boot();
  try {
    const c = await signup(t, "donor", "Photo Test");
    const jpg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]).toString("base64");
    assert.strictEqual((await c.act("profile.avatar", { photo: jpg })).s, 200);
    assert.strictEqual((await c.act("profile.avatar", { photo: "data:image/png;base64,iVBORw0KGgo=" })).s, 422);
    assert.strictEqual((await c.act("profile.avatar", { photo: "data:image/jpeg;base64," + Buffer.from("<script>alert(1)</script>").toString("base64") })).s, 422, "magic bytes are checked, not the label");
    assert.strictEqual((await c.act("profile.avatar", { photo: "data:image/jpeg;base64," + "A".repeat(70000) })).s, 422);
    assert.strictEqual((await c.act("profile.update", { name: "X", phone: "123", area: "Dwarka", addr: "12 Test Street", x: PX.donor, acceptTerms: true })).s, 422);
    assert.strictEqual((await c.act("profile.update", { name: "Photo Test", phone: "9876543210", area: "Mars", addr: "12 Test Street", x: PX.donor, acceptTerms: true })).s, 422);
    assert.strictEqual((await c.act("profile.update", { name: "Photo Test", phone: "9876543210", area: "Dwarka", addr: "12 Test Street", x: PX.donor, acceptTerms: false })).s, 422, "terms must be accepted");
  } finally { await t.close(); }
});
test("idempotency keys on actions: a retried request does not create a duplicate", async () => {
  const t = await boot();
  try {
    const c = await signup(t, "donor", "Idem Test"); const h = { "Idempotency-Key": "k-1" };
    const a = await c.act("donation.create", DON(), h), b = await c.act("donation.create", DON(), h);
    assert.strictEqual(a.s, 200); assert.strictEqual(b.s, 200); assert.strictEqual(b.h.get("idempotent-replay"), "true"); assert.strictEqual(a.b.result.id, b.b.result.id);
    assert.strictEqual((await c.act("donation.create", DON({ title: "Different dish" }), h)).s, 422);
    assert.strictEqual((await c.get("/api/v1/view")).b.view.don.length, 1);
    assert.strictEqual((await c.act("donation.create", DON(), { "Idempotency-Key": "bad key!" })).s, 400);
  } finally { await t.close(); }
});
test("soft delete: donors hide listings that have no orders; listings with orders are protected", async () => {
  const t = await boot();
  try {
    const w = await world(t);
    const o = await w.ngo.act("order.create", { donation: w.don, qty: 5, needed: 5 }); assert.strictEqual(o.s, 200);
    const blocked = await w.donor.act("donation.delete", { id: w.don }); assert.strictEqual(blocked.s, 409);
    await w.ngo.act("order.cancel", { id: o.b.result.id });
    assert.strictEqual((await w.donor.act("donation.delete", { id: w.don })).s, 200);
    assert.ok(!(await w.donor.get("/api/v1/view")).b.view.don.some((d) => d.id === w.don));
    const rec = (await t.app.store.get({ fresh: true })).state.don.find((d) => d.id === w.don); assert.ok(rec.deletedAt, "record is kept with deletedAt");
    assert.ok(!(await w.ngo.get("/api/v1/view")).b.view.don.some((d) => d.id === w.don), "deleted food disappears for NGOs");
  } finally { await t.close(); }
});
