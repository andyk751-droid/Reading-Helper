// Decode Space Adventure: lets the installed app open and play offline.
// The page itself is fetched fresh whenever there's internet, so updates show up right away.
const VERSION = "decode-v25";
const CORE = ["./", "index.html", "manifest.webmanifest",
  "img/icon-192.png", "img/icon-512.png", "img/owl-64.png", "img/owl-180.png", "img/owl-512.png",
  "img/crate-gold.webp", "img/crate.webp", "img/orbit-cheer-poster.webp", "img/orbit-cheer.webp", "img/orbit-main.webp",
  "img/orbit-point.webp", "img/orbit-think.webp", "img/orbit-wave-poster.webp", "img/orbit-wave.webp",
  "img/planet-flip.webp", "img/planet-forge.webp", "img/planet-lab.webp", "img/planet-speed.webp", "img/planet-spell.webp", "img/planet-swap.webp",
  "img/rank-0.webp", "img/rank-1.webp", "img/rank-2.webp", "img/rank-3.webp", "img/rank-4.webp", "img/ship.webp", "img/space-bg.webp"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k.startsWith("decode-")).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Videos stream with range requests: leave them to the network (the game shows still images if offline).
  if (url.pathname.endsWith(".mp4")) return;
  // Fonts: keep a copy so the app looks right offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; })));
    return;
  }
  if (url.origin !== location.origin) return; // voice, class sync, feedback: always live
  // The page: try the network first so updates arrive immediately; fall back to the saved copy offline.
  if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put("index.html", r.clone())); return r; })
      .catch(() => caches.match("index.html").then((m) => m || caches.match("./"))));
    return;
  }
  // Pictures and other files: use the saved copy, refresh it in the background.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req);
    const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
