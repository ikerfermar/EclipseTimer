"use strict";

const CACHE_VERSION = "eclipsetimer-v26";
// Los splash screens de iOS (assets/splash/*) se han sacado a propósito de
// este precache: solo los pide Safari en iOS/iPadOS, así que precachearlos
// aquí obligaba a Android a descargar ~1.6MB que nunca va a usar. El
// manejador de "fetch" de abajo ya los cachea la primera vez que Safari los
// pida (stale-while-revalidate), así que siguen funcionando offline igual.
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
  "assets/fonts/inter-600.woff2"
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
