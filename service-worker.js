const CACHE = "afe-charge-test-v30";
const CORE = ["./index.html", "./config.js?v=afe-v30", "./api.js?v=afe-v30", "./recording.js?v=afe-v30", "./recording.css?v=afe-v30", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("afe-charge-test-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || request.headers.has("Authorization")) return;
  if (request.mode === "navigate") {
    const scope = new URL(self.registration.scope).pathname;
    if (url.pathname !== scope && url.pathname !== scope + "index.html") return;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
          await cache.put("./index.html", response.clone());
        }
        return response;
      } catch {
        return await cache.match("./index.html") || Response.error();
      }
    })());
    return;
  }
  if (CORE.some(asset => new URL(asset, self.registration.scope).href === url.href)) {
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(request) || fetch(request)));
  }
});
