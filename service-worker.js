"use strict";

// IMPORTANT: bump CACHE_VERSION on every deploy that touches index.html,
// app.js or styles.css. If this string is byte-for-byte identical to the
// previous deploy, the browser won't detect an update, the install/activate
// cycle never runs, and clients keep being served the old cached files with
// no error or warning of any kind.
const CACHE_VERSION = "eclipsetimer-v80";
// How long we wait for a fresh network response for core app-shell files
// before falling back to the cached copy. This matters most on a remote
// observation site with slow/intermittent connectivity (the typical
// scenario for this app on eclipse day): a too-short timeout makes the
// "silent fallback to stale cache" look like a flaky/inconsistent update.
const UPDATE_TIMEOUT_MS = 6000;

// iOS splash screens are requested only by Safari/iPadOS. They are cached on
// first request instead of being forced into the app shell for every platform.
const APP_SHELL = [
  "./",
  "index.html",
  "alerts.json",
  "paypal.json",
  "styles.css",
  "app.js",
  "core.mjs",
  "lunar-profile-worker.js",
  "manifest.webmanifest",
  "assets/images/logo-32.png",
  "assets/images/logo-48.png",
  "assets/images/logo-96.png",
  "assets/images/logo-180.png",
  "assets/images/logo-192.png",
  "assets/images/logo-512.png",
  "assets/images/logo-512-maskable.png",
  "assets/fonts/inter-400.woff2",
  "assets/fonts/inter-500.woff2",
  "assets/fonts/inter-600.woff2",
  "assets/data/lunar_contacts_2026.meta.json"
];

const CORE_UPDATE_URLS = new Set([
  new URL("./", self.location).href,
  new URL("index.html", self.location).href,
  new URL("alerts.json", self.location).href,
  new URL("paypal.json", self.location).href,
  new URL("styles.css", self.location).href,
  new URL("app.js", self.location).href,
  new URL("core.mjs", self.location).href,
  new URL("lunar-profile-worker.js", self.location).href,
  new URL("manifest.webmanifest", self.location).href
]);

function cacheResponse(request, response) {
  if (!response || !response.ok) return;
  const cloned = response.clone();
  caches.open(CACHE_VERSION).then((cache) => {
    cache.put(request, cloned).catch(() => {
      // Ignore opaque/cors/unsupported cache writes.
    });
  });
}

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    cacheResponse(request, response);
    return response;
  });
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("network timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    );
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const oldAppCaches = keys.filter((key) => key.startsWith("eclipsetimer-") && key !== CACHE_VERSION);
      return Promise.all(oldAppCaches.map((key) => caches.delete(key)))
        .then(() => self.clients.claim())
        .then(() => {
          if (!oldAppCaches.length) return null;
          return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            clients.forEach((client) => {
              client.postMessage({ type: "ET_FORCE_RELOAD", version: CACHE_VERSION });
            });
          });
        });
    })
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const shouldPreferFresh = event.request.mode === "navigate" || CORE_UPDATE_URLS.has(url.href);
      let networkFetch = null;
      const getNetworkFetch = () => {
        if (!networkFetch) networkFetch = fetchAndCache(event.request).catch(() => null);
        return networkFetch;
      };
      const offlineFallback = () => {
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("index.html");
        return Promise.reject(new Error("offline and not cached"));
      };

      if (shouldPreferFresh) {
        if (!cached) {
          return getNetworkFetch().then((response) => response || offlineFallback());
        }
        return withTimeout(getNetworkFetch(), UPDATE_TIMEOUT_MS)
          .then((response) => response || offlineFallback())
          .catch(() => {
            event.waitUntil(getNetworkFetch().catch(() => {}));
            return offlineFallback();
          });
      }

      if (cached) return cached;

      return getNetworkFetch().then((response) => {
        if (response) return response;
        if (event.request.mode === "navigate") {
          return caches.match("index.html");
        }
        return Promise.reject(new Error("offline and not cached"));
      });
    })
  );
});
