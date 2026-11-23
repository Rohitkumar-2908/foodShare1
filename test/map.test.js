"use strict";
// The real street map (Leaflet + light CARTO tiles). Runs the page's own map code against a fake Leaflet.
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("fs");
const path = require("path");
const { CSP } = require("../server");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const DOMAIN = fs.readFileSync(path.join(__dirname, "..", "src", "domain.js"), "utf8");

function fakeLeaflet(opts = {}) {
  const log = { markers: [], lines: [], fit: null, tiles: null, removed: 0, popups: 0, handlers: {} };
  const L = {
    Browser: { mobile: false },
    map(el, o) {
      if (opts.mapThrows) throw new Error("boom");
      log.mapOpts = o; const m = { fitBounds(b, o2) { log.fit = { b, o2 }; }, invalidateSize() {}, remove() { log.removed++; }, getContainer: () => el };
      return m;
    },
    tileLayer(url, o) { log.tiles = { url, o }; const t = { addTo() { return t; }, on(ev, f) { log.handlers[ev] = f; return t; } }; return t; },
    divIcon: (o) => o,
    marker(ll, o) {
      const mk = { ll, o, tips: [], addTo() { log.markers.push(mk); return mk; }, bindTooltip(t, oo) { mk.tips.push({ t, oo }); return mk; }, on(ev, f) { mk[ev] = f; return mk; } };
      return mk;
    },
    polyline(pts, o) { const l = { pts, o, addTo() { log.lines.push(l); return l; } }; return l; },
    latLngBounds: (pts) => pts,
    popup() { const p = { setLatLng() { return p; }, setContent(c) { p.c = c; return p; }, openOn() { log.popups++; } }; return p; },
  };
  return { L, log };
}

function load(L) {
  const els = [];
  const node = () => ({ children: [], textContent: "", appendChild(c) { this.children.push(c); return c; } });
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, setImmediate, URL, AbortController, TextEncoder, Blob, performance,
    crypto: globalThis.crypto, fetch: async () => { throw new Error("offline"); }, location: { hash: "" }, innerWidth: 1000, innerHeight: 800,
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 0, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
    IntersectionObserver: class { observe() {} disconnect() {} }, devicePixelRatio: 1,
    document: { querySelector: () => ({ value: "", textContent: "", innerHTML: "", dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getBoundingClientRect: () => ({}), parentNode: {} }),
      querySelectorAll: (sel) => (sel === ".lmap:not([data-ok])" ? els.filter((e) => !e.ok) : []),
      createElement: node, createTextNode: (t) => ({ textContent: t }), body: { appendChild() {}, contains: (c) => !c.gone }, documentElement: { style: { setProperty() {} } }, addEventListener() {}, activeElement: null, hidden: false },
  };
  if (L) ctx.L = L;
  ctx.window = ctx; ctx.globalThis = ctx;
  let src = HTML.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const end = src.lastIndexOf("})();");
  src = src.slice(0, end) + "globalThis.__t={mapBox:mapBox,drawMap:drawMap,initMaps:initMaps,svgMap:svgMap,GEO:GEO,AREA:AREA,A:A,S:S};" + src.slice(end);
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const mkEl = (html) => { const e = { html, ok: false, attrs: {}, clientHeight: 360,
    get innerHTML() { return this.html; }, set innerHTML(v) { this.html = v; },
    getAttribute(k) { return k === "data-lm" ? this.dm : null; }, setAttribute(k) { if (k === "data-ok") this.ok = true; } };
    const m = /data-lm="([^"]*)"/.exec(html); e.dm = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    els.push(e); return e; };
  return { t: ctx.__t, mkEl, ctx };
}

test("every area has map coordinates inside Delhi NCR, matching the server's area list", () => {
  const { t } = load(null);
  const server = DOMAIN.match(/const AREAS = \[([^\]]*)\]/)[1].split(",").map((x) => x.trim().replace(/"/g, ""));
  assert.deepStrictEqual(Object.keys(t.GEO).sort(), server.slice().sort());
  assert.deepStrictEqual(Object.keys(t.AREA).sort(), server.slice().sort());
  for (const [k, [lat, lng]] of Object.entries(t.GEO)) { assert.ok(lat > 28.3 && lat < 28.9 && lng > 76.8 && lng < 77.6, k + " is in Delhi NCR"); }
});

test("page loads Leaflet from the allowed CDN, pinned, and the CSP permits tiles and its stylesheet", () => {
  assert.match(HTML, /cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\/leaflet\.min\.js/);
  assert.match(HTML, /cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\/leaflet\.min\.css/);
  assert.match(HTML, /light_all/, "light (white) basemap");
  assert.match(CSP, /img-src [^;]*https:\/\/\*\.basemaps\.cartocdn\.com/);
  assert.match(CSP, /style-src [^;]*https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(CSP, /script-src [^;]*https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(CSP, /connect-src 'self'/, "tiles are images, so connect-src stays locked down");
  assert.ok(!/localStorage|sessionStorage/.test(HTML.match(/function drawMap[\s\S]*?\nfunction initMaps/)[0]));
});

test("without Leaflet (offline/blocked) the schematic fallback stays and nothing throws", () => {
  const { t, mkEl } = load(null);
  const html = t.mapBox({ Dwarka: 30 }, [], "Test map", true);
  assert.match(html, /class="lmap"/); assert.match(html, /<svg class="map"/); assert.match(html, /data-act="area"/);
  const el = mkEl(html); t.initMaps(); assert.strictEqual(el.ok, false, "nothing initialised, fallback untouched"); assert.match(el.html, /<svg/);
});

test("with Leaflet: light tiles, one marker per area, labels, sizes by meals, fit to bounds", () => {
  const { L, log } = fakeLeaflet(); const { t, mkEl } = load(L);
  const el = mkEl(t.mapBox({ Dwarka: 80, Saket: 20 }, [], "Meals by area", false)); t.initMaps();
  assert.strictEqual(el.ok, true); assert.strictEqual(log.markers.length, 7);
  assert.match(log.tiles.url, /basemaps\.cartocdn\.com\/light_all/); assert.strictEqual(log.tiles.o.subdomains, "abcd"); assert.match(log.tiles.o.attribution, /OpenStreetMap/); assert.match(log.tiles.o.attribution, /CARTO/);
  assert.strictEqual(log.mapOpts.scrollWheelZoom, false, "page scrolling is not hijacked");
  const dw = log.markers.find((m) => m.o.alt.startsWith("Dwarka")), sk = log.markers.find((m) => m.o.alt.startsWith("Saket")), rh = log.markers.find((m) => m.o.alt === "Rohini");
  assert.strictEqual(dw.o.alt, "Dwarka (80)"); assert.ok(dw.o.icon.iconSize[0] > sk.o.icon.iconSize[0] && sk.o.icon.iconSize[0] > rh.o.icon.iconSize[0], "bigger pin for more meals");
  assert.match(dw.o.title, /80 meals/, "accessible name"); assert.match(rh.o.icon.html, /pin off/);
  assert.strictEqual(dw.tips[0].oo.permanent, true, "labels shown on the big map");
  assert.deepStrictEqual(Array.from(log.fit.b).length, 7); assert.ok(log.fit.o2.maxZoom <= 12);
  dw.click(); assert.strictEqual(log.popups, 1, "pin opens a popup");
});

test("popup links to Google Maps and is built without innerHTML", () => {
  const { L, log } = fakeLeaflet(); const { t, mkEl } = load(L);
  let pop; L.popup = () => { const p = { setLatLng() { return p; }, setContent(c) { pop = c; return p; }, openOn() {} }; return p; };
  mkEl(t.mapBox({ Saket: 5 }, [], "m", false)); t.initMaps(); log.markers.find((m) => m.o.alt.startsWith("Saket")).click();
  const a = pop.children.find((c) => c.href); assert.match(a.href, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Saket/); assert.strictEqual(a.rel, "noopener");
});

test("finder map: clicking a pin filters by area and the selected area is highlighted", () => {
  const { L, log } = fakeLeaflet(); const { t, ctx, mkEl } = load(L);
  let picked = null; t.A.area = (v) => { picked = v; };
  t.S.area = "Rohini"; mkEl(t.mapBox({ Rohini: 10, Noida: 4 }, [], "Finder", true)); t.initMaps();
  const ro = log.markers.find((m) => m.o.alt.startsWith("Rohini")), no = log.markers.find((m) => m.o.alt.startsWith("Noida"));
  assert.match(ro.o.icon.html, /pin sel/); assert.ok(!/sel/.test(no.o.icon.html));
  no.click(); assert.strictEqual(picked, "Noida"); void ctx;
});

test("route map draws dashed lines between areas and zooms to the route", () => {
  const { L, log } = fakeLeaflet(); const { t, mkEl } = load(L);
  mkEl(t.mapBox({ Dwarka: 1, Saket: 1 }, [["Dwarka", "Saket"], ["Saket", "Saket"], ["Nowhere", "Saket"]], "Route", false)); t.initMaps();
  assert.strictEqual(log.lines.length, 1, "self-loops and unknown areas are skipped"); assert.ok(log.lines[0].o.dashArray);
  assert.strictEqual(Array.from(log.fit.b).length, 2, "zooms to the two stops only");
});

test("failures fall back to the schematic: Leaflet throws, or tiles never load", () => {
  let f = fakeLeaflet({ mapThrows: true }); let w = load(f.L);
  const html = w.t.mapBox({ Dwarka: 3 }, [], "x", false), el = w.mkEl(html); w.t.initMaps();
  assert.match(el.html, /<svg class="map"/, "schematic restored after an exception");
  f = fakeLeaflet(); w = load(f.L); const el2 = w.mkEl(w.t.mapBox({ Dwarka: 3 }, [], "x", false)); w.t.initMaps();
  assert.ok(!/<svg/.test(el2.html)); for (let i = 0; i < 4; i++) f.log.handlers.tileerror();
  assert.match(el2.html, /<svg class="map"/, "tiles blocked -> schematic restored"); assert.strictEqual(f.log.removed, 1);
  f = fakeLeaflet(); w = load(f.L); const el3 = w.mkEl(w.t.mapBox({ Dwarka: 3 }, [], "x", false)); w.t.initMaps();
  f.log.handlers.tileload(); for (let i = 0; i < 10; i++) f.log.handlers.tileerror();
  assert.ok(!/<svg/.test(el3.html), "a few failed tiles after some loaded keep the real map");
});

test("maps whose container left the page are destroyed (no leaks)", () => {
  const { L, log } = fakeLeaflet(); const { t, mkEl } = load(L);
  const el = mkEl(t.mapBox({ Dwarka: 1 }, [], "x", false)); t.initMaps();
  const cont = {}; // fake map's container is the element itself; mark it as gone
  el.gone = true; mkEl(t.mapBox({ Saket: 1 }, [], "y", false)); t.initMaps();
  assert.strictEqual(log.removed, 1); void cont;
});

test("the three map spots on the page all use the real map", () => {
  assert.match(HTML, /h\+=mapBox\(m,\[\],"Map of approved meals by area",true\)/);
  assert.match(HTML, /return svgMap\(c,\[\],MAPT\[r\]\)/);
  assert.match(HTML, /svgMap\(cnt,lines,"Route map of your active deliveries"\)/);
  assert.ok(!/street tiles can’t load/.test(HTML), "old 'tiles can't load' note removed");
});
