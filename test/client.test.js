"use strict";
// Runs the real frontend script against the real server with a minimal fake DOM,
// to prove the browser code and the secured API work together (login, CSRF, views, actions).
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("fs");
const path = require("path");
const { boot, signup, complete, adminClient, PASS } = require("./helpers");

const HTML = path.join(__dirname, "..", "public", "index.html");

function makeEnv(base) {
  const els = new Map(), hs = {};
  const mk = () => ({ value: "", textContent: "", innerHTML: "", checked: false, hidden: false, dataset: {}, style: {}, files: [], classList: { add() {}, remove() {}, toggle() {} },
    insertAdjacentHTML() {}, setAttribute() {}, focus() {}, select() {}, appendChild() {}, reset() {}, remove() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), parentNode: { clientWidth: 100, clientHeight: 100 } });
  const el = (s) => { if (!els.has(s)) els.set(s, mk()); return els.get(s); };
  const jar = { c: "" };
  const myFetch = async (url, o = {}) => {
    const h = Object.assign({}, o.headers); if (jar.c) h.cookie = jar.c;
    const r = await fetch(base + url, Object.assign({}, o, { headers: h, signal: undefined }));
    const sc = r.headers.get("set-cookie"); if (sc) { const m = /fs_sid=([^;]*)/.exec(sc); if (m) jar.c = m[1] ? "fs_sid=" + m[1] : ""; }
    return r;
  };
  const loc = { _h: "" , set hash(v) { this._h = "#" + String(v).replace(/^#/, ""); setImmediate(() => hs.route && hs.route()); }, get hash() { return this._h; } };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, setImmediate, URL, AbortController, TextEncoder, Blob, performance,
    crypto: globalThis.crypto, fetch: myFetch, location: loc, innerWidth: 1000, innerHeight: 800,
    sessionStorage: { _: {}, getItem(k) { return this._[k] || null; }, setItem(k, v) { this._[k] = String(v); }, removeItem(k) { delete this._[k]; } },
    localStorage: { _: {}, getItem(k) { return this._[k] || null; }, setItem(k, v) { this._[k] = String(v); }, removeItem(k) { delete this._[k]; } },
    matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 0, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
    IntersectionObserver: class { observe() {} disconnect() {} }, devicePixelRatio: 1,
    document: { querySelector: el, querySelectorAll: () => [], createElement: mk, body: { appendChild() {} }, documentElement: { style: { setProperty() {} } }, addEventListener() {}, activeElement: null, hidden: false },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  return { ctx, el, hs, loc, jar };
}
async function load(base) {
  const env = makeEnv(base);
  let src = fs.readFileSync(HTML, "utf8").match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const end = src.lastIndexOf("})();");
  src = src.slice(0, end) + "globalThis.__t={TABS:TABS,A:A,API:API,SRV:SRV,SRVFORM:SRVFORM,me:me,route:route,getDB:function(){return DB},loadView:loadView};" + src.slice(end);
  vm.createContext(env.ctx); vm.runInContext(src, env.ctx);
  env.t = env.ctx.__t; env.hs.route = env.t.route;
  for (let i = 0; i < 100 && !env.t.API.server; i++) await new Promise((r) => setTimeout(r, 20));
  return env;
}
const set = (env, o) => Object.keys(o).forEach((k) => { env.el(k).value = o[k]; });

test("frontend detects the server, registers, completes a profile, lists food, and sees only its own data", async () => {
  const t = await boot();
  try {
    const e = await load(t.base);
    assert.strictEqual(e.t.API.server, true, "server mode detected");
    assert.strictEqual(e.t.me(), null);
    set(e, { "#rn": "Harness Donor", "#re": "hd@example.org", "#rp": "Str0ng-Passw0rd" });
    await e.t.SRVFORM.fup({ dataset: { role: "donor" } });
    assert.ok(e.t.API.uid > 0 && e.t.API.csrf, "session and CSRF token received");
    assert.strictEqual(e.loc.hash, "#donor"); assert.strictEqual(e.t.me().role, "donor");
    assert.ok(!("pw" in e.t.me()) && !("hash" in e.t.me()));
    set(e, { "#pn": "Harness Donor", "#pph": "9876543210", "#pa": "Dwarka", "#pad": "12 Test Street", "#px0": "Restaurant", "#px1": "" });
    e.el("#pt").checked = true;
    await e.t.SRVFORM.fpf({});
    assert.ok(e.t.me().terms, "profile saved on the server"); assert.strictEqual(e.t.me().ver, "pending");
    set(e, { "#dt": "Harness curry", "#dc": "cooked", "#dd": "veg", "#dq": "12", "#da": "1", "#ds": "cold", "#dl": "Dwarka", "#dad": "1 Road" });
    await e.t.SRVFORM.fdon({});
    assert.strictEqual(e.t.getDB().don.length, 1); assert.strictEqual(e.t.getDB().don[0].title, "Harness curry");
    set(e, { "#dq": "0" }); await e.t.SRVFORM.fdon({});
    assert.match(e.el("#derr").textContent, /Meals must be/, "server validation message is shown");
    e.t.A.tab("Overview");
    assert.match(e.el("#app").innerHTML, /Welcome to your donor dashboard/, "greeting for the donor role"); assert.match(e.el("#app").innerHTML, /Good (morning|afternoon|evening), Harness/);
    assert.match(e.el("#app").innerHTML, /data-v="Map"/, "extra dashboard tabs are present");
    for (const tab of ["Map", "Help", "Analytics", "Listings"]) { e.t.A.tab(tab); assert.ok(e.el("#app").innerHTML.length > 500, tab + " renders"); }
    e.t.A.tab("Help"); assert.match(e.el("#app").innerHTML, /Quick answers/);
    await e.t.SRV.out();
    assert.strictEqual(e.t.me(), null); assert.strictEqual(e.t.getDB().don.length, 0, "signed-out view has no donations");
    e.t.route(); assert.match(e.el("#app").innerHTML, /class="ring"/, "home page shows the 3D photo ring"); assert.strictEqual((e.el("#app").innerHTML.match(/class="rc"/g) || []).length, 8);
    assert.match(e.el("#app").innerHTML, /Terms and conditions/);
    assert.ok(e.t.getDB().stats.users >= 2, "public stats come from the server");
  } finally { await t.close(); }
});
test("frontend falls back to browser-only mode when no server answers", async () => {
  const e = await load("http://127.0.0.1:9");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(e.t.API.server, false); assert.strictEqual(e.t.API.mode, "Browser local storage");
});
test("frontend: wrong password message, admin sign-in, verify flow, and role limits through the UI code", async () => {
  const t = await boot();
  try {
    const e = await load(t.base);
    set(e, { "#le": "admin@example.org", "#lp": "Wrong-Pass1" }); await e.t.SRVFORM.fin({ dataset: {} });
    assert.match(e.el("#lerr").textContent, /incorrect/); assert.strictEqual(e.t.me(), null);
    set(e, { "#lp": "Adm1n-Pass-Phrase" }); await e.t.SRVFORM.fin({ dataset: {} });
    assert.strictEqual(e.t.me().role, "admin"); assert.strictEqual(e.loc.hash, "#admin");
    // a second browser: an NGO registers and the admin verifies them
    const n = await load(t.base);
    set(n, { "#rn": "Harness Ngo", "#re": "hn@example.org", "#rp": "Str0ng-Passw0rd" }); await n.t.SRVFORM.fup({ dataset: { role: "ngo" } });
    set(n, { "#pn": "Harness Ngo", "#pph": "9876543210", "#pa": "Rohini", "#pad": "5 Ngo Street", "#px0": "REG12345", "#px1": "Contact Person" }); n.el("#pt").checked = true; await n.t.SRVFORM.fpf({});
    await n.t.SRV.order(1);
    const toastText = n.el("#toast").textContent; assert.match(toastText, /./, "an error is shown instead of silently failing");
    const ngoId = n.t.me().id;
    await e.t.loadView(); assert.ok(e.t.getDB().users.some((u) => u.id === ngoId && u.email === "hn@example.org"), "admin view includes staff-level details");
    await e.t.SRV.ver(ngoId); await n.t.loadView(); assert.strictEqual(n.t.me().ver, "verified");
    assert.ok(!n.t.getDB().users.some((u) => u.id !== ngoId && u.email), "the NGO's own view contains nobody else's email");
  } finally { await t.close(); }
});

test("every role can sign in through the frontend and every dashboard tab renders with real data", async () => {
  const t = await boot();
  try {
    const admin = await adminClient(t);
    const made = await admin.act("admin.createInspector", { name: "Smoke Inspector", email: "smoke-insp@example.org" });
    const ins = t.client(); await ins.post("/api/v1/auth/reset", { token: made.b.result.token, password: PASS }); await ins.post("/api/v1/auth/login", { email: "smoke-insp@example.org", password: PASS }); await complete(ins, "inspector");
    const donor = await signup(t, "donor", "Smoke Donor", "smoke-donor@example.org"); await complete(donor, "donor");
    const ngo = await signup(t, "ngo", "Smoke Ngo", "smoke-ngo@example.org"); await complete(ngo, "ngo"); await admin.act("user.verify", { id: ngo.id });
    const org = await signup(t, "organiser", "Smoke Organiser", "smoke-org@example.org"); await complete(org, "organiser"); await admin.act("user.verify", { id: org.id });
    const dist = await signup(t, "distributor", "Smoke Dist", "smoke-dist@example.org"); await complete(dist, "distributor"); await admin.act("user.verify", { id: dist.id });
    await org.act("drive.create", { name: "Winter drive", date: "2026-12-31", needed: 100 });
    const d = (await donor.act("donation.create", { title: "Smoke curry", cat: "cooked", diet: "veg", qty: 30, age: 1, storage: "cold", area: "Saket", addr: "3 Road" })).b.result.id;
    await donor.act("donation.create", { title: "Pending dish", cat: "bakery", diet: "veg", qty: 5, age: 1, storage: "cold", area: "Noida", addr: "" });
    await ins.act("quality.pass", { id: d, checks: [true, true, true, true], temp: 70 });
    const o1 = (await ngo.act("order.create", { donation: d, qty: 10, needed: 20 })).b.result.id;
    await org.act("order.create", { donation: d, qty: 5, needed: 5, drive: 1 });
    await dist.act("delivery.accept", { id: o1 });
    await t.client().post("/api/v1/contact", { name: "Visitor", email: "v@example.org", message: "Hello, I would like to help out" });
    const people = [["smoke-donor@example.org", "donor", /donor dashboard/], ["smoke-ngo@example.org", "ngo", /NGO dashboard/], ["smoke-org@example.org", "organiser", /organiser dashboard/], ["smoke-dist@example.org", "distributor", /distributor dashboard/], ["smoke-insp@example.org", "inspector", /Welcome, inspector/], ["admin@example.org", "admin", /Welcome back/]];
    for (const [email, role, greet] of people) {
      const e = await load(t.base);
      set(e, { "#le": email, "#lp": email.startsWith("admin") ? "Adm1n-Pass-Phrase" : PASS });
      await e.t.SRVFORM.fin({ dataset: {} });
      assert.strictEqual(e.t.me().role, role, email + " signed in");
      for (const tab of e.t.TABS[role]) {
        e.t.A.tab(tab);
        const html = e.el("#app").innerHTML;
        const clean = html.replace(/aria-label="[^"]*"/g, ""), bad = /undefined|NaN|\[object/.exec(clean);
        assert.ok(html.length > 400 && !bad, role + " / " + tab + " renders cleanly" + (bad ? ": ..." + clean.slice(Math.max(0, bad.index - 120), bad.index + 60) : ""));
        if (tab === "Overview") assert.match(html, greet, role + " greeting");
      }
    }
  } finally { await t.close(); }
});
