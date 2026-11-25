const CACHE = "afe-charge-production-v42";
const CORE = ["./index.html", "./leaflet.js", "./leaflet.css", "./rivonia-map.png", "./account-session.js?v=afe-v42", "./account-ui.js?v=afe-v42", "./account.css?v=afe-v42", "./legal.html", "./config.js?v=afe-v42", "./api.js?v=afe-v42", "./production-commands.js?v=afe-v42", "./production-payments.js?v=afe-v42", "./driver-home.js?v=afe-v42", "./driver-tabs.js?v=afe-v42", "./jsQR.js", "./recording.js?v=afe-v42", "./recording.css?v=afe-v42", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE.map(asset => new Request(asset, {cache:"reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  const retired = key => key !== CACHE && (key.startsWith("afe-charge-test-") || key.startsWith("afe-charge-production-"));
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(retired).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  // A tab still running the old app may attempt to poll or submit after this worker takes control.
  if (url.hostname === "afe-peach-sandbox-webhook-296426724305.africa-south1.run.app") {
    event.respondWith(Response.error());
    return;
  }
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
