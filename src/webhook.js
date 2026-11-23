"use strict";
// Outbound signed webhooks with an SSRF guard. Retries happen in the job queue.
const crypto = require("crypto");
const dns = require("dns").promises;

function isPrivateIp(ip) {
  ip = String(ip).toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertSafeUrl(u, allowPrivate) {
  const url = new URL(u);
  if (allowPrivate) return url; // tests / trusted internal receivers only
  if (url.protocol !== "https:") throw new Error("webhook URL must use https");
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("webhook host is not allowed");
  return url;
}
const sign = (secret, ts, body) => "sha256=" + crypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex");
// Receivers call this. Any secret in the list matches, so secrets can be rotated without downtime.
function verify(secrets, ts, body, sig) {
  return secrets.some((s) => {
    const a = Buffer.from(sign(s, ts, body)), b = Buffer.from(String(sig || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
async function deliver(cfg, evt) {
  const url = await assertSafeUrl(cfg.webhookUrl, cfg.webhookAllowPrivate);
  const body = JSON.stringify(evt), ts = String(Math.floor(Date.now() / 1000));
  const headers = { "Content-Type": "application/json", "X-FoodShare-Timestamp": ts, "X-FoodShare-Event": evt.type };
  if (cfg.webhookSecrets[0]) headers["X-FoodShare-Signature"] = sign(cfg.webhookSecrets[0], ts, body);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(url, { method: "POST", headers, body, signal: ctl.signal, redirect: "error" });
    if (!r.ok) throw new Error("webhook responded " + r.status);
  } finally { clearTimeout(t); }
}
module.exports = { deliver, verify, sign, isPrivateIp, assertSafeUrl };
