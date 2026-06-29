// Service worker — caches the app shell so the workbench opens fast and feels app-like.
// Never caches /api/ (dynamic: extraction, vision, library, jobs). Registers only in a
// secure context (https / localhost); over plain-HTTP LAN the app still works, just uncached.
const CACHE = "rheo-workbench-v10-obsidian";
const SHELL = ["/", "/upload.html", "/styles.css?v=obsidian-1", "/upload.js?v=obsidian-1",
               "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // cache-first for the shell; network-first fallthrough for everything else
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
