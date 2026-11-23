"use strict";
// Business rules + per-role data views. Every action checks role, ownership and state on the server.
const crypto = require("crypto");
const { newToken, sha256 } = require("./auth");

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}
const bad = (m) => new HttpError(422, "validation_failed", m);
const AREAS = ["Connaught Place", "Dwarka", "Rohini", "Saket", "Noida", "Gurugram", "Karol Bagh"];
const CATS = ["cooked", "packaged", "produce", "bakery"];
const SELF_ROLES = ["donor", "ngo", "distributor", "organiser"];
const PX = { donor: [["sel", ["Restaurant", "Hotel", "Hostel", "Household", "Event caterer"]], ["txt", 0]], ngo: [["txt", 1], ["txt", 1]], distributor: [["sel", ["On foot", "Bicycle", "Motorbike", "Car", "Van"]], ["txt", 0]], organiser: [["txt", 1], ["sel", ["Wedding", "Corporate", "Community", "Festival", "Other"]]], inspector: [["txt", 1], ["txt", 0]], admin: [] };

function str(v, name, min, max) { if (typeof v !== "string") throw bad(name + " must be text"); const s = v.trim(); if (s.length < min || s.length > max) throw bad(name + " must be " + min + " to " + max + " characters"); return s; }
function int(v, name, min, max) { if (!Number.isInteger(v) || v < min || v > max) throw bad(name + " must be a whole number from " + min + " to " + max); return v; }
function num(v, name, min, max) { if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw bad(name + " must be a number from " + min + " to " + max); return v; }
function oneOf(v, name, list) { if (!list.includes(v)) throw bad(name + " is not an allowed value"); return v; }
const emptyState = () => ({ users: [], don: [], ord: [], drv: [], log: [], msg: [], sessions: [], resets: [], seq: 1, v: 4 });
const evt = (s, m) => { s.log.unshift({ t: Date.now(), m: String(m).slice(0, 200) }); if (s.log.length > 200) s.log.length = 200; };
const nid = (s) => s.seq++;
const find = (a, id) => a.find((x) => x.id === id);
const need = (x, what) => { if (!x) throw new HttpError(404, "not_found", what + " not found"); return x; };
const forbid = (msg) => new HttpError(403, "forbidden", msg || "You are not allowed to do that");
const ordered = (s, d) => s.ord.filter((o) => o.don === d.id && o.s !== "cancelled").reduce((a, o) => a + o.qty, 0);

function checkPhoto(p) {
  if (p === "" || p === undefined || p === null) return "";
  if (typeof p !== "string" || p.length > 60000) throw bad("Photo is too large");
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(p);
  if (!m) throw bad("Photo must be a JPEG image");
  const b = Buffer.from(m[1], "base64"); // check JPEG magic bytes, not just the label
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) throw bad("That does not look like a valid JPEG");
  return p;
}
function checkMem(m) {
  if (!m || typeof m !== "object") throw bad("Invalid memory");
  const f = {};
  if (m.f && typeof m.f === "object") for (const k of Object.keys(m.f).slice(0, 10)) if (/^[a-z]{1,12}$/.test(k)) f[k] = String(m.f[k]).slice(0, 100);
  const h = Array.isArray(m.h) ? m.h.slice(-30).filter((x) => x && (x.r === "u" || x.r === "b") && typeof x.t === "string").map((x) => ({ r: x.r, t: x.t.slice(0, 700) })) : [];
  return { f, h };
}
function checkX(role, x) {
  const cfg = PX[role] || [];
  if (!Array.isArray(x) || x.length !== cfg.length) throw bad("Fill in all role details");
  return cfg.map((c, i) => {
    const v = typeof x[i] === "string" ? x[i].trim().slice(0, 40) : "";
    if (c[0] === "sel") return oneOf(v, "Option", c[1]);
    if (c[1] === 1 && v.length < 3) throw bad("Fill in all required role details");
    return v;
  });
}
function mkReset(s, uid, by, now, minutes) {
  const token = newToken();
  s.resets = (s.resets || []).filter((r) => r.exp > now && r.uid !== uid);
  s.resets.push({ id: nid(s), uid, th: sha256(token), exp: now + minutes * 60000, by });
  return token;
}
function newUser(s, { name, email, role, pw, now }) {
  const u = { id: nid(s), name, email, role, pw, credits: 0, area: "", addr: "", phone: "", x: [], terms: null, ver: null, seed: 0, photo: "", mem: { f: {}, h: [] }, deletedAt: null, created: now };
  s.users.push(u); return u;
}

// ---------- actions ----------
const A = {};
A["donation.create"] = { roles: ["donor"], run(s, c, p) {
  const d = { id: nid(s), donor: c.user.id, title: str(p.title, "Food description", 3, 60), cat: oneOf(p.cat, "Category", CATS), diet: oneOf(p.diet, "Dietary type", ["veg", "nonveg"]), qty: int(p.qty, "Meals", 1, 2000), age: num(p.age, "Hours since prepared", 0, 48), storage: oneOf(p.storage, "Storage", ["room", "cold"]), area: oneOf(p.area, "Area", AREAS), addr: p.addr ? str(p.addr, "Address", 0, 80) : "", q: { s: "pending", n: "" }, deletedAt: null };
  d.rem = d.qty;
  if (d.cat === "cooked" && d.storage !== "cold" && d.age > 4) d.q = { s: "failed", n: "Auto-rejected: cooked food older than 4 hours without refrigeration." };
  s.don.push(d); evt(s, c.user.name + " listed " + d.title); return { id: d.id, status: d.q.s };
} };
A["donation.update"] = { roles: ["donor"], run(s, c, p) {
  const d = need(find(s.don, p.id), "Donation"); if (d.donor !== c.user.id || d.deletedAt) throw new HttpError(404, "not_found", "Donation not found");
  const o = ordered(s, d), q = int(p.qty, "Meals", Math.max(1, o), 2000);
  d.qty = q; d.rem = q - o; return {};
} };
A["donation.delete"] = { roles: ["donor"], run(s, c, p) {
  const d = need(find(s.don, p.id), "Donation"); if (d.donor !== c.user.id || d.deletedAt) throw new HttpError(404, "not_found", "Donation not found");
  if (ordered(s, d)) throw new HttpError(409, "has_orders", "This donation has active orders and cannot be deleted");
  d.deletedAt = c.now; evt(s, c.user.name + " removed a listing"); return {}; // soft delete
} };
A["order.create"] = { roles: ["ngo", "organiser"], verified: true, run(s, c, p) {
  const d = need(find(s.don, p.donation), "Donation");
  if (d.deletedAt || d.q.s !== "passed") throw new HttpError(409, "not_approved", "This donation is not approved for distribution");
  const qty = int(p.qty, "Quantity", 1, 2000);
  if (qty > d.rem) throw new HttpError(409, "not_enough", "Only " + d.rem + " meals are left", { remaining: d.rem });
  const needed = int(p.needed, "Meals needed", qty, 100000);
  let drv = 0;
  if (p.drive) { drv = int(p.drive, "Drive", 1, 1e9); const dr = find(s.drv, drv); if (!dr || dr.org !== c.user.id) throw forbid("Choose one of your own drives"); }
  d.rem -= qty; // atomic: the whole action is one compare-and-set write, so two buyers cannot both take the last meals
  const o = { id: nid(s), don: d.id, by: c.user.id, qty, needed, drv, s: "placed", t: c.now };
  s.ord.push(o); evt(s, c.user.name + " ordered " + qty + " meals"); return { id: o.id };
} };
A["order.cancel"] = { roles: ["ngo", "organiser"], run(s, c, p) {
  const o = need(find(s.ord, p.id), "Order"); if (o.by !== c.user.id) throw new HttpError(404, "not_found", "Order not found");
  if (o.s !== "placed") throw new HttpError(409, "bad_state", "Only orders waiting for a distributor can be cancelled");
  o.s = "cancelled"; const d = find(s.don, o.don); if (d) d.rem += o.qty; return {};
} };
A["delivery.accept"] = { roles: ["distributor"], verified: true, run(s, c, p) {
  const o = need(find(s.ord, p.id), "Order"); if (o.s !== "placed") throw new HttpError(409, "taken", "This delivery was already taken");
  o.s = "assigned"; o.dist = c.user.id; o.otp = String(crypto.randomInt(1000, 10000)); o.tries = 0; o.lockUntil = 0;
  evt(s, c.user.name + " accepted a delivery"); return {};
} };
A["delivery.pickup"] = { roles: ["distributor"], run(s, c, p) {
  const o = need(find(s.ord, p.id), "Order"); if (o.dist !== c.user.id) throw new HttpError(404, "not_found", "Order not found");
  if (o.s !== "assigned") throw new HttpError(409, "bad_state", "This delivery is not waiting for pickup");
  if (o.lockUntil > c.now) throw new HttpError(429, "locked", "Too many wrong codes. Try again in a few minutes.", { retryAfterSec: Math.ceil((o.lockUntil - c.now) / 1000) });
  const code = typeof p.code === "string" ? p.code.trim() : "";
  const a = Buffer.from(code), b = Buffer.from(o.otp);
  if (!/^\d{4}$/.test(code) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    o.tries = (o.tries || 0) + 1;
    if (o.tries >= 5) { o.lockUntil = c.now + 15 * 60000; o.tries = 0; evt(s, "Pickup code locked after repeated wrong tries"); }
    const e = new HttpError(403, "wrong_code", "That code does not match. Check it with the donor."); e.commit = true; throw e; // persist the attempt counter
  }
  o.s = "picked"; return {};
} };
A["order.receive"] = { roles: ["ngo", "organiser"], run(s, c, p) {
  const o = need(find(s.ord, p.id), "Order"); if (o.by !== c.user.id) throw new HttpError(404, "not_found", "Order not found");
  if (o.s !== "picked") throw new HttpError(409, "bad_state", "This order has not been picked up yet");
  o.s = "delivered"; const dist = find(s.users, o.dist), d = find(s.don, o.don), donor = d && find(s.users, d.donor);
  if (dist) { dist.credits += 10 + Math.ceil(o.qty / 10); }
  if (donor) donor.credits += Math.floor(o.qty / 5);
  evt(s, "Order delivered: " + o.qty + " meals"); return {};
} };
A["quality.pass"] = { roles: ["inspector"], run(s, c, p) {
  const d = need(find(s.don, p.id), "Donation"); if (d.deletedAt || d.q.s !== "pending") throw new HttpError(409, "bad_state", "This donation is not waiting for a test");
  if (!Array.isArray(p.checks) || p.checks.length !== 4 || !p.checks.every((x) => x === true)) throw bad("Tick every check before passing");
  const t = num(p.temp, "Core temperature", -40, 150);
  if (t < 60 && t > 5) throw bad("Temperature is in the unsafe zone (above 5 and below 60 °C). Fail this food.");
  d.q = { s: "passed", n: p.note ? str(p.note, "Note", 0, 120) : "", by: c.user.id };
  const donor = find(s.users, d.donor); if (donor) donor.credits += 5; evt(s, "Inspector approved " + d.title); return {};
} };
A["quality.fail"] = { roles: ["inspector"], run(s, c, p) {
  const d = need(find(s.don, p.id), "Donation"); if (d.deletedAt || d.q.s !== "pending") throw new HttpError(409, "bad_state", "This donation is not waiting for a test");
  d.q = { s: "failed", n: str(p.note, "Note", 3, 120), by: c.user.id }; evt(s, "Inspector rejected " + d.title); return {};
} };
const staffTarget = (s, c, id) => {
  const x = need(find(s.users, id), "User");
  if (x.id === c.user.id) throw forbid("You cannot do that to your own account");
  if (x.role === "admin" && c.user.role !== "admin") throw forbid("Only an admin can do that to an admin");
  return x;
};
A["user.verify"] = { roles: ["admin", "inspector"], run(s, c, p) {
  const x = staffTarget(s, c, p.id); if (x.role === "admin") throw forbid("Admins are always verified");
  if (!x.terms) throw new HttpError(409, "incomplete", "This user has not completed their profile yet");
  x.ver = x.ver === "verified" ? "pending" : "verified"; evt(s, (x.ver === "verified" ? "Verified " : "Unverified ") + x.email); return { ver: x.ver };
} };
A["user.suspend"] = { roles: ["admin", "inspector"], run(s, c, p) {
  const x = staffTarget(s, c, p.id); x.sus = !x.sus; if (x.sus) s.sessions = s.sessions.filter((q) => q.uid !== x.id);
  evt(s, (x.sus ? "Suspended " : "Reinstated ") + x.email); return { sus: x.sus };
} };
A["user.remove"] = { roles: ["admin", "inspector"], run(s, c, p) {
  const x = staffTarget(s, c, p.id); s.users = s.users.filter((q) => q !== x); s.sessions = s.sessions.filter((q) => q.uid !== x.id); evt(s, "Removed account " + x.email); return {};
} };
A["user.reset"] = { roles: ["admin"], run(s, c, p) {
  const x = staffTarget(s, c, p.id); const token = mkReset(s, x.id, c.user.id, c.now, 30); evt(s, "Password reset code issued for " + x.email); return { token, minutes: 30 };
} };
A["admin.createInspector"] = { roles: ["admin"], run(s, c, p) {
  const name = str(p.name, "Name", 2, 50), email = str(p.email, "Email", 5, 100).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Enter a valid email address");
  if (s.users.some((u) => u.email === email)) throw new HttpError(409, "exists", "An account with this email already exists");
  const u = newUser(s, { name, email, role: "inspector", pw: null, now: c.now }); const token = mkReset(s, u.id, c.user.id, c.now, 24 * 60);
  evt(s, "Admin created inspector account " + email); return { token, minutes: 24 * 60, id: u.id };
} };
A["drive.create"] = { roles: ["organiser"], run(s, c, p) {
  const date = str(p.date, "Date", 10, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw bad("Date must look like 2026-12-31");
  const d = { id: nid(s), org: c.user.id, name: str(p.name, "Drive name", 3, 60), date, needed: int(p.needed, "Meals needed", 1, 100000) };
  s.drv.push(d); return { id: d.id };
} };
A["drive.delete"] = { roles: ["organiser"], run(s, c, p) {
  const d = need(find(s.drv, p.id), "Drive"); if (d.org !== c.user.id) throw new HttpError(404, "not_found", "Drive not found"); s.drv = s.drv.filter((x) => x !== d); return {};
} };
A["admin.donation.delete"] = { roles: ["admin"], run(s, c, p) {
  const d = need(find(s.don, p.id), "Donation"); s.ord = s.ord.filter((o) => o.don !== d.id); s.don = s.don.filter((x) => x !== d); evt(s, "Admin deleted donation " + d.title); return {};
} };
A["admin.order.cancel"] = { roles: ["admin"], run(s, c, p) {
  const o = need(find(s.ord, p.id), "Order"); if (o.s === "delivered" || o.s === "cancelled") throw new HttpError(409, "bad_state", "This order is already finished");
  const d = find(s.don, o.don); if (d) d.rem += o.qty; o.s = "cancelled"; evt(s, "Admin cancelled an order"); return {};
} };
A["admin.message.delete"] = { roles: ["admin"], run(s, c, p) { s.msg = s.msg.filter((m) => m.id !== p.id); return {}; } };
const ALL = ["donor", "ngo", "distributor", "organiser", "inspector", "admin"];
A["profile.update"] = { roles: ALL, run(s, c, p) {
  const u = c.user, name = str(p.name, "Name", 2, 50), phone = String(p.phone || "").replace(/[\s()-]/g, "");
  if (!/^\+?\d{10,15}$/.test(phone)) throw bad("Enter a valid phone number (10 to 15 digits)");
  let area = u.area, addr = u.addr;
  if (SELF_ROLES.includes(u.role)) { area = oneOf(p.area, "Area", AREAS); addr = str(p.addr, "Street address", 5, 80); }
  const x = checkX(u.role, p.x), first = !u.terms;
  if (first && p.acceptTerms !== true) throw bad("Accept the terms to continue");
  Object.assign(u, { name, phone, area, addr, x }); if (first) u.terms = c.now;
  u.ver = u.role === "admin" || u.ver === "verified" ? "verified" : "pending";
  evt(s, u.email + (first ? " completed their profile" : " updated their profile")); return {};
} };
A["profile.avatar"] = { roles: ALL, run(s, c, p) {
  if (p.seed !== undefined) c.user.seed = int(p.seed, "Avatar", 0, 1e6);
  if (p.photo !== undefined) c.user.photo = checkPhoto(p.photo);
  return {};
} };
A["memory.save"] = { roles: ALL, run(s, c, p) { c.user.mem = checkMem(p.mem); return {}; } };
A["account.export"] = { roles: ALL, run(s, c) {
  const u = c.user, own = s.don.filter((d) => d.donor === u.id);
  return { exportedAt: new Date(c.now).toISOString(), profile: selfUser(u), donations: own, orders: s.ord.filter((o) => o.by === u.id || o.dist === u.id || own.some((d) => d.id === o.don)).map(noOtp), contactMessages: s.msg.filter((m) => m.e === u.email) };
} };
A["account.delete"] = { roles: ["donor", "ngo", "distributor", "organiser", "inspector"], run(s, c) {
  const u = c.user, em = u.email;
  s.don.forEach((d) => { if (d.donor === u.id) d.addr = ""; }); s.msg = s.msg.filter((m) => m.e !== em); s.sessions = s.sessions.filter((q) => q.uid !== u.id);
  Object.assign(u, { name: "Deleted user", email: "deleted-" + u.id + "@deleted.invalid", phone: "", addr: "", photo: "", x: [], mem: { f: {}, h: [] }, pw: null, totp: null, sus: true, deletedAt: c.now });
  delete u.hash; delete u.salt;
  evt(s, "Account " + u.id + " deleted at the owner's request (personal data erased)"); return {};
} };

// ---------- views (row-level security) ----------
function selfUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, credits: u.credits, area: u.area || "", addr: u.addr || "", phone: u.phone || "", x: u.x || [], terms: u.terms || null, ver: u.ver || null, sus: !!u.sus, seed: u.seed || 0, photo: u.photo || "", mem: u.mem || { f: {}, h: [] }, totpOn: !!(u.totp && u.totp.on), recoveryLeft: u.totp && u.totp.rec ? u.totp.rec.length : 0 };
}
const pubUser = (u) => ({ id: u.id, name: u.name, role: u.role, credits: u.credits, sus: !!u.sus });
const staffUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, credits: u.credits, area: u.area || "", addr: u.addr || "", phone: u.phone || "", x: u.x || [], terms: u.terms || null, ver: u.ver || null, sus: !!u.sus, seed: u.seed || 0, photo: u.photo || "", deletedAt: u.deletedAt || null });
const noOtp = (o) => { const c = Object.assign({}, o); delete c.otp; delete c.tries; delete c.lockUntil; return c; };
const donorOrder = (o) => { const c = Object.assign({}, o); delete c.tries; delete c.lockUntil; if (o.s !== "assigned") delete c.otp; return c; };

function stats(s) {
  return { users: s.users.filter((u) => !u.deletedAt).length, approved: s.don.filter((d) => !d.deletedAt && d.q.s === "passed").length, delivered: s.ord.filter((o) => o.s === "delivered").reduce((a, o) => a + o.qty, 0) };
}
function viewFor(s, user) {
  const board = s.users.filter((u) => (u.role === "distributor" || u.role === "donor") && !u.deletedAt).map(pubUser);
  const live = s.don.filter((d) => !d.deletedAt);
  if (!user) return { users: board, don: [], ord: [], drv: [], log: [], msg: [], stats: stats(s) };
  const users = new Map(board.map((u) => [u.id, u]));
  const addUsers = (ids, fn) => ids.forEach((id) => { const u = find(s.users, id); if (u) users.set(id, fn(u)); });
  let don = [], ord = [], drv = [], log = [], msg = [];
  const r = user.role;
  if (r === "admin" || r === "inspector") {
    s.users.forEach((u) => users.set(u.id, staffUser(u)));
    don = live; ord = s.ord.map(noOtp); drv = s.drv; log = s.log; if (r === "admin") msg = s.msg;
  } else if (r === "donor") {
    don = live.filter((d) => d.donor === user.id); const mine = new Set(don.map((d) => d.id));
    ord = s.ord.filter((o) => mine.has(o.don)).map(donorOrder);
    addUsers(ord.flatMap((o) => [o.by, o.dist].filter(Boolean)), pubUser);
  } else if (r === "ngo" || r === "organiser") {
    ord = s.ord.filter((o) => o.by === user.id).map(noOtp);
    const ids = new Set(ord.map((o) => o.don));
    don = live.filter((d) => d.q.s === "passed" || ids.has(d.id));
    if (r === "organiser") drv = s.drv.filter((d) => d.org === user.id);
  } else if (r === "distributor") {
    ord = s.ord.filter((o) => o.s === "placed" || o.dist === user.id).map(noOtp);
    const accepted = new Set(ord.filter((o) => o.dist === user.id).map((o) => o.id));
    const ids = new Set(ord.map((o) => o.don));
    don = live.filter((d) => ids.has(d.id)).map((d) => {
      const mineO = ord.some((o) => o.don === d.id && accepted.has(o.id));
      return mineO ? d : Object.assign({}, d, { addr: "" }); // exact pickup address only after accepting
    });
    ord.forEach((o) => {
      const open = !accepted.has(o.id), d = find(s.don, o.don), req = find(s.users, o.by), dn = d && find(s.users, d.donor);
      [req, dn].filter(Boolean).forEach((u) => users.set(u.id, open ? { id: u.id, name: u.name, role: u.role, credits: u.credits, sus: !!u.sus, area: u.area || "" } : { id: u.id, name: u.name, role: u.role, credits: u.credits, sus: !!u.sus, area: u.area || "", addr: u.addr || "", phone: u.phone || "" }));
    });
  }
  users.set(user.id, selfUser(find(s.users, user.id) || user));
  return { users: Array.from(users.values()), don, ord, drv, log, msg, stats: stats(s) };
}
module.exports = { HttpError, ACTIONS: A, viewFor, selfUser, emptyState, evt, nid, newUser, mkReset, AREAS, SELF_ROLES, noOtp };
