"use strict";

// Bump this on every deploy that changes any cached file — it both busts the
// cache and, because the browser byte-diffs sw.js itself to detect updates,
// is what makes a new deploy install a new service worker at all.
const CACHE_NAME = "wot-cache-v26";

const PRECACHE_URLS = [
  "./",
  "index.html",
  "style.css?v=26",
  "app.js?v=26",
  "manifest.json",
  "data/countries.geojson",
  "data/marine.geojson",
  "data/cities.json",
  "data/sealife.json",
  "data/voyages.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first for everything we precached (works fully offline once cached),
// falling back to the network — and caching what it fetches — for anything
// else same-origin. Cross-origin requests are left untouched.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
