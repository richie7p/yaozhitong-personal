import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../public/sw.js", import.meta.url),
  "utf8",
);
const origin = "https://example.firebaseapp.com";

interface WorkerRequest {
  url: string;
  method: string;
  mode: string;
}

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn(
    async (_request: WorkerRequest) => new Response("network"),
  );
  const cache = {
    match: vi.fn(
      async (_request: WorkerRequest) => new Response("cached asset"),
    ),
    put: vi.fn(),
  };
  const caches = {
    open: vi.fn(async (_name: string) => cache),
    match: vi.fn(async (_path: string) => new Response("offline shell")),
  };
  const clients = {
    matchAll: vi.fn(
      async () =>
        [] as {
          url: string;
          focus: ReturnType<typeof vi.fn>;
        }[],
    ),
    openWindow: vi.fn(async (_url: string) => ({})),
  };
  const registration = {
    showNotification: vi.fn(async () => {}),
    getNotifications: vi.fn(async () => [{}]),
  };
  runInNewContext(source, {
    URL,
    fetch,
    caches,
    self: {
      location: { origin },
      clients,
      registration,
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
    },
  });
  function dispatch(path: string, mode = "navigate", method = "GET") {
    const request = { url: new URL(path, origin).href, mode, method };
    const respondWith = vi.fn((_response: Promise<Response>) => {});
    listeners.get("fetch")!({ request, respondWith });
    return { request, respondWith };
  }
  return { fetch, caches, cache, clients, registration, listeners, dispatch };
}

describe("service worker authentication boundaries", () => {
  it.each([
    ["/__", "navigate"],
    ["/__/", "navigate"],
    ["/__/auth/handler?state=synthetic", "navigate"],
    ["/__/auth/iframe", "navigate"],
    ["/__/auth/handler.js", "no-cors"],
    ["/__/firebase/init.json", "cors"],
  ])("leaves Firebase reserved request %s to the browser", (path, mode) => {
    const sw = worker();
    sw.fetch.mockRejectedValue(new Error("offline"));
    const event = sw.dispatch(path, mode);
    // In particular, an unavailable callback must never become the app shell.
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(sw.caches.open).not.toHaveBeenCalled();
    expect(sw.caches.match).not.toHaveBeenCalled();
  });

  it.each(["/", "/__ordinary-page"])(
    "preserves online navigation outside the reserved namespace: %s",
    async (path) => {
      const sw = worker();
      const event = sw.dispatch(path);
      const response = await event.respondWith.mock.calls[0][0];
      expect(await response.text()).toBe("network");
      expect(sw.fetch).toHaveBeenCalledWith(event.request);
      expect(sw.caches.match).not.toHaveBeenCalled();
    },
  );

  it("retains the normal page's offline shell fallback", async () => {
    const sw = worker();
    sw.fetch.mockRejectedValue(new Error("offline"));
    const event = sw.dispatch("/");
    const response = await event.respondWith.mock.calls[0][0];
    expect(await response.text()).toBe("offline shell");
    expect(sw.caches.match).toHaveBeenCalledWith("/");
  });

  it("continues to serve a cached public shell asset", async () => {
    const sw = worker();
    const event = sw.dispatch("/icon.svg", "no-cors");
    const response = await event.respondWith.mock.calls[0][0];
    expect(await response.text()).toBe("cached asset");
    expect(sw.cache.match).toHaveBeenCalledWith(event.request);
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/v1/me", "GET"],
    ["/internal/tick", "GET"],
    ["/", "POST"],
    ["https://other.example/__/auth/handler", "GET"],
  ])("keeps existing request exclusions: %s %s", (path, method) => {
    const sw = worker();
    const event = sw.dispatch(path, "navigate", method);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(sw.caches.open).not.toHaveBeenCalled();
    expect(sw.caches.match).not.toHaveBeenCalled();
  });
});

describe("service worker reminders", () => {
  it("reports an actual worker display rejection without leaking the payload or raw error", async () => {
    const sw = worker();
    const postMessage = vi.fn();
    const otherMessage = vi.fn();
    sw.clients.matchAll.mockResolvedValue([
      { url: origin + "/#profile", focus: vi.fn(), postMessage },
      {
        url: origin + "/__/auth/iframe",
        focus: vi.fn(),
        postMessage: otherMessage,
      },
    ] as any);
    sw.registration.showNotification.mockRejectedValue(
      Object.assign(new Error("private payload detail"), {
        name: "NotAllowedError",
      }),
    );
    const waitUntil = vi.fn();
    sw.listeners.get("push")!({
      data: {
        json: () => ({
          notification: { title: "private", body: "private body" },
        }),
      },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(postMessage).toHaveBeenCalledWith({
      type: "yzt-notification-display",
      attempt: {
        source: "push",
        state: "failed",
        attemptedAt: expect.any(String),
        errorCode: "NotAllowedError",
      },
    });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("private");
    expect(otherMessage).not.toHaveBeenCalled();
  });

  it("reports display acceptance separately from finding a retained notification", async () => {
    const sw = worker();
    const postMessage = vi.fn();
    sw.clients.matchAll.mockResolvedValue([
      { url: origin + "/", focus: vi.fn(), postMessage },
    ] as any);
    sw.registration.getNotifications.mockResolvedValue([]);
    const waitUntil = vi.fn();
    sw.listeners.get("push")!({ data: null, waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({
          state: "accepted",
          notificationPresent: false,
        }),
      }),
    );
  });

  it("uses a fixed harmless message for a user-requested display test and replies only to that request", async () => {
    const sw = worker();
    const postMessage = vi.fn();
    const waitUntil = vi.fn();
    sw.listeners.get("message")!({
      data: {
        type: "yzt-test-notification",
        requestId: "test-123",
        title: "untrusted",
      },
      source: { type: "window", url: origin + "/#profile" },
      ports: [{ postMessage }],
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      "藥智通｜裝置通知測試",
      expect.objectContaining({
        body: "這是測試通知，無須服藥。看到後可關閉這則通知。",
        requireInteraction: true,
      }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      requestId: "test-123",
      attempt: {
        source: "test",
        state: "accepted",
        attemptedAt: expect.any(String),
        notificationPresent: true,
      },
    });
    expect(sw.clients.matchAll).not.toHaveBeenCalled();
  });

  it.each([
    origin + "/__/auth/handler",
    "https://other.example/",
    origin + "/elsewhere",
  ])("ignores a notification test request from %s", (url) => {
    const sw = worker();
    const waitUntil = vi.fn();
    sw.listeners.get("message")!({
      data: { type: "yzt-test-notification", requestId: "test-123" },
      source: { type: "window", url },
      ports: [{ postMessage: vi.fn() }],
      waitUntil,
    });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sw.registration.showNotification).not.toHaveBeenCalled();
  });

  it("displays an FCM reminder and preserves the occurrence tag for deduplication", async () => {
    const sw = worker();
    const waitUntil = vi.fn();
    sw.listeners.get("push")!({
      data: {
        json: () => ({
          notification: {
            title: "藥智通提醒",
            body: "用藥時間到了，請開啟藥智通查看並記錄。",
            tag: "synthetic-occurrence",
          },
          fcmMessageId: "transport-message-1",
        }),
      },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      "藥智通提醒",
      {
        body: "用藥時間到了，請開啟藥智通查看並記錄。",
        icon: "/icon-192.png",
        tag: "synthetic-occurrence",
        data: { url: "/#home" },
      },
    );
  });

  it.each(["invalid-json", "empty", "null"])(
    "uses a generic reminder for %s without exposing raw payload text",
    async (kind) => {
      const sw = worker();
      const waitUntil = vi.fn();
      sw.listeners.get("push")!({
        data:
          kind === "empty"
            ? null
            : {
                json: () => {
                  if (kind === "invalid-json") throw new Error("synthetic");
                  return null;
                },
              },
        waitUntil,
      });
      await waitUntil.mock.calls[0][0];
      expect(sw.registration.showNotification).toHaveBeenCalledWith(
        "藥智通提醒",
        expect.objectContaining({ body: "請開啟藥智通查看提醒。" }),
      );
    },
  );

  it("focuses the existing application without opening a new unauthenticated tab", async () => {
    const sw = worker();
    const focus = vi.fn(async () => ({}));
    sw.clients.matchAll.mockResolvedValue([
      { url: origin + "/#learning?medication=synthetic", focus },
    ]);
    const close = vi.fn();
    const waitUntil = vi.fn();
    sw.listeners.get("notificationclick")!({
      notification: { close, data: { url: "https://untrusted.example" } },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
    expect(sw.clients.matchAll).toHaveBeenCalledWith({
      type: "window",
      includeUncontrolled: true,
    });
  });

  it("ignores OAuth helpers and other origins before opening the fixed application entry", async () => {
    const sw = worker();
    const focus = vi.fn(async () => ({}));
    sw.clients.matchAll.mockResolvedValue([
      { url: origin + "/__/auth/handler", focus },
      { url: origin + "/another-page", focus },
      { url: "https://untrusted.example/", focus },
    ]);
    const waitUntil = vi.fn();
    sw.listeners.get("notificationclick")!({
      notification: {
        close: vi.fn(),
        data: { url: "https://untrusted.example" },
      },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(focus).not.toHaveBeenCalled();
    expect(sw.clients.openWindow).toHaveBeenCalledExactlyOnceWith("/#home");
  });

  it("opens a new app tab if an existing window closes while being focused", async () => {
    const sw = worker();
    sw.clients.matchAll.mockResolvedValue([
      {
        url: origin + "/",
        focus: vi.fn().mockRejectedValue(new Error("closed")),
      },
    ]);
    const waitUntil = vi.fn();
    sw.listeners.get("notificationclick")!({
      notification: { close: vi.fn() },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];
    expect(sw.clients.openWindow).toHaveBeenCalledExactlyOnceWith("/#home");
  });
});
