"use strict";
// Password hashing (scrypt), tokens, TOTP two-factor codes (RFC 6238), sealing of secrets at rest.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const scrypt = (pw, salt, N) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw, N = 16384) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, N);
  return { alg: "scrypt", N, salt: salt.toString("base64"), hash: h.toString("base64") };
}
async function verifyPassword(pw, rec) {
  if (!rec || rec.alg !== "scrypt") return false;
  const h = await scrypt(pw, Buffer.from(rec.salt, "base64"), rec.N);
  const b = Buffer.from(rec.hash, "base64");
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}
let dummy = null; // verifying against a dummy record keeps response time similar for unknown emails
const dummyRecord = async (N) => dummy || (dummy = await hashPassword("not-a-real-password", N));

const COMMON = new Set(["password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "iloveyou1", "admin123", "welcome1", "letmein123", "abc12345", "foodshare1", "foodshare123"]);
function passwordProblem(pw, email) {
  if (typeof pw !== "string") return "Password is required.";
  if (pw.length < 8 || pw.length > 128) return "Password must be 8 to 128 characters.";
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return "Use letters and at least one number.";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common.";
  if (email && pw.toLowerCase().includes(String(email).split("@")[0].toLowerCase()) && String(email).split("@")[0].length >= 4) return "Password must not contain your email name.";
  return null;
}
const newToken = () => crypto.randomBytes(32).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- TOTP ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(buf) {
  let bits = 0, v = 0, out = "";
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  let bits = 0, v = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/=+$/, "")) { const i = B32.indexOf(c); if (i < 0) throw new Error("bad base32"); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secretBuf, t = Date.now(), digits = 6, step = 30) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = crypto.createHmac("sha1", secretBuf).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}
function verifyTotp(secretB32, code, t = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const sec = b32dec(secretB32);
  for (let w = -window; w <= window; w++) if (safeEq(totp(sec, t + w * 30000), code)) return true;
  return false;
}
const newTotpSecret = () => b32enc(crypto.randomBytes(20));

// ---- sealing secrets at rest (AES-256-GCM) ----
function loadKey(dataDir) {
  const env = require("./config").secret("DATA_KEY");
  if (env) { if (!/^[0-9a-f]{64}$/i.test(env)) throw new Error("DATA_KEY must be 64 hex characters"); return Buffer.from(env, "hex"); }
  const f = path.join(dataDir, ".datakey");
  try { return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex"); }
  catch (e) { fs.mkdirSync(dataDir, { recursive: true }); const k = crypto.randomBytes(32); fs.writeFileSync(f, k.toString("hex"), { mode: 0o600 }); return k; }
}
function seal(key, plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
function open(key, sealed) {
  const [iv, tag, ct] = String(sealed).split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
// Stateless signed ticket (used between password step and 2FA step)
function signTicket(key, payload) { const b = Buffer.from(JSON.stringify(payload)).toString("base64url"); return b + "." + crypto.createHmac("sha256", key).update(b).digest("base64url"); }
function readTicket(key, t) {
  const [b, sig] = String(t).split(".");
  if (!b || !sig || !safeEq(crypto.createHmac("sha256", key).update(b).digest("base64url"), sig)) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
module.exports = { hashPassword, verifyPassword, dummyRecord, passwordProblem, newToken, sha256, safeEq, totp, verifyTotp, newTotpSecret, b32enc, b32dec, loadKey, seal, open, signTicket, readTicket };
