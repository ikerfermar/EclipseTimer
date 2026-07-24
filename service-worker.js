"use strict";

const CACHE_VERSION = "eclipsetimer-v20";
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
  "assets/images/logo-512.png",
  "assets/images/logo-512-maskable.png",
  "assets/fonts/inter-400.woff2",
  "assets/fonts/inter-500.woff2",
  "assets/fonts/inter-600.woff2",
  "assets/splash/iphone-1290x2796.png",
  "assets/splash/iphone-1179x2556.png",
  "assets/splash/iphone-1284x2778.png",
  "assets/splash/iphone-1170x2532.png",
  "assets/splash/iphone-1125x2436.png",
  "assets/splash/iphone-1242x2688.png",
  "assets/splash/iphone-828x1792.png",
  "assets/splash/iphone-750x1334.png",
  "assets/splash/ipad-1620x2160.png",
  "assets/splash/ipad-1668x2388.png",
  "assets/splash/ipad-2048x2732.png",
  "assets/splash/ipad-2160x1620.png",
  "assets/splash/ipad-2388x1668.png",
  "assets/splash/ipad-2732x2048.png"
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
      // Antes, si algo ya estaba en caché, se servía para siempre sin
      // volver a comprobar la red hasta el próximo ciclo de vida del SW.
      // Ahora revalidamos en segundo plano: la respuesta cacheada sigue
      // siendo instantánea, pero si hay red disponible la caché se
      // actualiza para la próxima vez, sin esperar a un cambio de versión.
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const cloned = response.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(event.request, cloned).catch(() => {
                // Ignore opaque/cors/unsupported cache writes.
              });
            });
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(networkFetch.catch(() => {}));
        return cached;
      }

      return networkFetch.then((response) => {
        if (response) return response;
        // Only fall back to the app shell for page navigations. For any
        // other uncached asset (image, font, etc.) let the request fail
        // normally instead of silently returning the HTML document.
        if (event.request.mode === "navigate") {
          return caches.match("index.html");
        }
        return Promise.reject(new Error("offline and not cached"));
      });
    })
  );
});
