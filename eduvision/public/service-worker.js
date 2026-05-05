const CACHE_NAME = "curiox-cache-v17";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-72x72.png",
  "./icons/icon-96x96.png",
  "./icons/icon-128x128.png",
  "./icons/icon-144x144.png",
  "./icons/icon-152x152.png",
  "./icons/icon-192x192.png",
  "./icons/icon-384x384.png",
  "./icons/icon-512x512.png"
];

// Install event — cache all assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[CurioX SW] Caching app assets");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate event — clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log("[CurioX SW] Deleting old cache:", name);
            return caches.delete(name);
          })
      )
    )
  );
  self.clients.claim();
});

//const CACHE_NAME = "curiox-cache-v11";

// Fetch event — serve from cache, fallback to network
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // ── NEVER cache these — pass straight to network ──────────────────────────
  // 1. POST requests (Cache API doesn't support them)
  // 2. API calls (/api/*) — always need fresh responses
  // 3. Non-http(s) schemes (chrome-extension://, etc.)
  if (
    req.method !== "GET" ||
    req.url.includes("/api/") ||
    !req.url.startsWith("http")
  ) {
    return; // let browser handle normally — no SW interception
  }

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(req).then((networkResponse) => {
        // Only cache same-origin successful GET responses
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === "basic"
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseClone);
          });
        }
        return networkResponse;
      });
    })
  );
});
