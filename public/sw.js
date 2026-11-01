// Only the public application shell is cached. APIs, images and health data are never cached.
const CACHE = "yzt-shell-v1";
const BUILD_ASSETS = [];
const SHELL_FILES = [
  "/",
  "/icon.svg",
  "/favicon.ico",
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
    // Firebase owns these URLs, including OAuth callbacks and their iframe.
    u.pathname === "/__" ||
    u.pathname.startsWith("/__/") ||
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
// Keep only display outcomes in messages to open app windows. No medication,
// account identifier, notification body, or push credential leaves the worker.
async function displayNotification(title, options, source) {
  const attempt = {
    source,
    state: "accepted",
    attemptedAt: new Date().toISOString(),
  };
  try {
    await self.registration.showNotification(title, options);
    try {
      const current = await self.registration.getNotifications({
        tag: options.tag,
      });
      attempt.notificationPresent = current.length > 0;
    } catch {
      // A missing diagnostics API must not affect the actual notification.
    }
  } catch (error) {
    attempt.state = "failed";
    attempt.errorCode = [
      "NotAllowedError",
      "InvalidStateError",
      "SecurityError",
    ].includes(error?.name)
      ? error.name
      : "UnknownError";
  }
  return attempt;
}
self.addEventListener("message", (event) => {
  if (
    event.data?.type !== "yzt-test-notification" ||
    typeof event.data.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(event.data.requestId) ||
    !event.ports?.[0]
  )
    return;
  const client = event.source;
  if (!client || client.type !== "window" || !client.url) return;
  const url = new URL(client.url);
  if (url.origin !== self.location.origin || url.pathname !== "/") return;
  event.waitUntil(
    (async () => {
      const attempt = await displayNotification(
        "藥智通｜裝置通知測試",
        {
          body: "這是測試通知，無須服藥。看到後可關閉這則通知。",
          icon: "/icon-192.png",
          tag: "yzt-display-test-" + event.data.requestId,
          requireInteraction: true,
          data: { url: "/#home" },
        },
        "test",
      );
      event.ports[0].postMessage({ requestId: event.data.requestId, attempt });
    })(),
  );
});
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    // A malformed payload still gets a generic reminder, never raw message text.
  }
  const n = payload.notification || {};
  event.waitUntil(
    (async () => {
      const attempt = await displayNotification(
        n.title || "藥智通提醒",
        {
          body: n.body || "請開啟藥智通查看提醒。",
          icon: "/icon-192.png",
          tag:
            n.tag || payload.webpush?.notification?.tag || payload.fcmMessageId,
          data: { url: "/#home" },
        },
        "push",
      );
      try {
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of windows) {
          const url = new URL(client.url);
          if (url.origin === self.location.origin && url.pathname === "/")
            client.postMessage({ type: "yzt-notification-display", attempt });
        }
      } catch {
        // Closing a diagnostic page must not interfere with the notification.
      }
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        const url = new URL(client.url);
        // Hash routes all live at /. Never focus Firebase's OAuth/helper windows.
        if (url.origin !== self.location.origin || url.pathname !== "/")
          continue;
        try {
          const focused = await client.focus();
          if (focused) return;
        } catch {
          // The tab may have closed between matchAll and focus.
        }
      }
      // Keep an existing tab's unsaved work and in-memory login intact. A fresh
      // window is needed only when no application tab can be focused.
      await self.clients.openWindow("/#home");
    })(),
  );
});
