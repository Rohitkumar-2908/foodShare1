"use strict";
process.env.LOG_LEVEL = "silent";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fs-api-"));
class Client {
  constructor(base) { this.base = base; this.cookie = ""; this.csrf = ""; this.setCookie = ""; }
  async req(method, p, body, headers = {}) {
    const h = Object.assign({}, headers);
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.csrf && method === "POST" && !("x-csrf-token" in h)) h["x-csrf-token"] = this.csrf;
    const r = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) { this.setCookie = sc; const m = /fs_sid=([^;]*)/.exec(sc); if (m) this.cookie = m[1] ? "fs_sid=" + m[1] : ""; }
    const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; }
    if (b && b.csrf) this.csrf = b.csrf;
    return { s: r.status, b, h: r.headers };
  }
  post(p, b, h) { return this.req("POST", p, b, h); }
  get(p, h) { return this.req("GET", p, undefined, h); }
  act(n, b, h) { return this.post("/api/v1/actions/" + n, b || {}, h); }
}
async function boot(over = {}) {
  const app = createApp(Object.assign({
    port: 0, host: "127.0.0.1", dataDir: tmp(), backupIntervalMin: 600, mongoUri: "", queueBaseMs: 5, shutdownMs: 2000,
    rateCapacity: 100000, writeCapacity: 100000, authCapacity: 100000, scryptN: 1024,
    adminEmail: "admin@example.org", adminPassword: "Adm1n-Pass-Phrase", lockoutMs: 60000,
  }, over));
  await app.start();
  const base = "http://127.0.0.1:" + app.server.address().port;
  return { app, base, client: () => new Client(base), close: () => app.shutdown("test") };
}
const PX = { donor: ["Restaurant", ""], ngo: ["REG12345", "Contact Person"], distributor: ["Bicycle", ""], organiser: ["Org Name", "Wedding"], inspector: ["Food safety cert", "5"], admin: [] };
const PASS = "Str0ng-Passw0rd";
async function signup(t, role, name, email) {
  const c = t.client();
  const r = await c.post("/api/v1/auth/register", { name, email: email || name.toLowerCase().replace(/\W/g, "") + "@example.org", password: PASS, role });
  if (r.s !== 201) throw new Error("register failed " + r.s + JSON.stringify(r.b));
  c.id = r.b.user.id; c.email = r.b.user.email; return c;
}
async function complete(c, role, extra) {
  const r = await c.act("profile.update", Object.assign({ name: "Test " + role, phone: "9876543210", area: "Dwarka", addr: "12 Test Street", x: PX[role], acceptTerms: true }, extra));
  if (r.s !== 200) throw new Error("profile failed " + r.s + JSON.stringify(r.b));
  return r;
}
async function adminClient(t) {
  const c = t.client();
  const r = await c.post("/api/v1/auth/login", { email: "admin@example.org", password: "Adm1n-Pass-Phrase" });
  if (r.s !== 200) throw new Error("admin login failed " + r.s + JSON.stringify(r.b));
  return c;
}
module.exports = { boot, tmp, Client, signup, complete, adminClient, PASS, PX };
