"use strict";

const CACHE_VERSION = "eclipsetimer-v4";
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "assets/images/logo-32.png",
  "assets/images/logo-48.png",
  "assets/images/logo-96.png",
  "assets/images/logo-180.png",
  "assets/images/logo-192.png",
  "assets/images/logo-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== CACHE_VERSION)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(event.request, cloned).catch(() => {
              // Ignore opaque/cors/unsupported cache writes.
            });
          });
          return response;
        })
        .catch(() => caches.match("index.html"));
    })
  );
});
