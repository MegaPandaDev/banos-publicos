const CACHE_NAME = "banos-publicos-v20";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/marcador-wc.svg",
  "./icons/wc.svg",
  "./icons/cafe.svg",
  "./icons/cruz.svg",
  "./icons/brujula.svg",
  "./icons/reportar.svg",
  "./icons/ubicacion.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Deja pasar sin tocar: peticiones a CDNs externos, y cualquier cosa que no sea GET
  // (las llamadas a /api/... son en su mayoría POST/PUT/DELETE y nunca deben servirse
  // desde caché; los GET a /api/... tampoco están precacheados, así que siempre van a
  // la red).
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
