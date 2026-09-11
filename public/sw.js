// Only the public application shell is cached. APIs, images and health data are never cached.
const CACHE = "yzt-shell-v1";
const BUILD_ASSETS = [];
const SHELL_FILES = [
  "/",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  ...BUILD_ASSETS,
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    u.origin !== self.location.origin ||
    u.pathname.startsWith("/api/") ||
    u.pathname.startsWith("/internal/")
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  if (SHELL_FILES.includes(u.pathname))
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const stored = await cache.match(event.request);
        if (stored) return stored;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      }),
    );
});
self.addEventListener("push", (event) => {
  const payload = event.data?.json() || {};
  const n = payload.notification || {};
  event.waitUntil(
    self.registration.showNotification(n.title || "藥智通提醒", {
      body: n.body || "請開啟藥智通查看提醒。",
      icon: "/icon.svg",
      tag: payload.webpush?.notification?.tag || payload.fcmMessageId,
      data: { url: "/#home" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/#home"));
});
