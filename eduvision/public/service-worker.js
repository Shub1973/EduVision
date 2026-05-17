const CACHE_NAME = "curiox-cache-v21";
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

// Fetch event — smart caching strategy
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ── NEVER intercept these ─────────────────────────────────────────────────
  // POST requests, API calls, non-http schemes (chrome-extension etc.)
  if (
    req.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    !req.url.startsWith("http")
  ) {
    return;
  }

  // ── NETWORK FIRST for HTML pages ─────────────────────────────────────────
  // Always fetch fresh HTML — fall back to cache only if offline
  // This ensures users always get latest index.html without clearing cache
  if (req.headers.get("accept") && req.headers.get("accept").includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return networkResponse;
        })
        .catch(() => caches.match(req)) // offline fallback
    );
    return;
  }

  // ── CACHE FIRST for all other assets (icons, fonts, etc.) ────────────────
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(req).then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === "basic"
        ) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      });
    })
  );
});
