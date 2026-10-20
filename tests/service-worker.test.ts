import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://example.firebaseapp.com";

interface WorkerRequest {
  url: string;
  method: string;
  mode: string;
}

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn(async (_request: WorkerRequest) => new Response("network"));
  const cache = {
    match: vi.fn(async (_request: WorkerRequest) => new Response("cached asset")),
    put: vi.fn(),
  };
  const caches = {
    open: vi.fn(async (_name: string) => cache),
    match: vi.fn(async (_path: string) => new Response("offline shell")),
  };
  runInNewContext(source, {
    URL,
    fetch,
    caches,
    self: {
      location: { origin },
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
  return { fetch, caches, cache, dispatch };
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
