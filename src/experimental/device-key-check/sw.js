const CACHE_NAME = "tamago-dev007-key-check-shell-v1";
const FILES = ["./", "./index.html", "./device-key-check.css", "./device-key-check.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("tamago-dev007-key-check-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;
  const scopePath = new URL("./", self.location).pathname;
  if (!requestUrl.pathname.startsWith(scopePath)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        if (event.request.mode === "navigate") return cache.match(new URL("./index.html", self.location));
        throw new Error("Recurso de prueba no disponible sin conexión");
      }
    }),
  );
});
