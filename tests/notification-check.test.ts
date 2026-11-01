import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNotificationAttempt,
  notificationDeviceStatus,
  testNotificationDisplay,
} from "../src/notification-check";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function environment(permission = "granted") {
  const port1 = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    close: vi.fn(),
  };
  const port2 = { close: vi.fn() };
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = port1;
      port2 = port2;
    },
  );
  vi.stubGlobal("window", { isSecureContext: true, Notification: {} });
  vi.stubGlobal("Notification", { permission });
  const postMessage = vi.fn();
  const getSubscription = vi.fn(async () => ({
    endpoint: "private-token-endpoint",
  }));
  const getRegistration = vi.fn(async () => ({
    active: { state: "activated", postMessage },
    pushManager: { getSubscription },
  }));
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
  return { port1, port2, postMessage, getRegistration };
}

describe("notification display checks", () => {
  it("returns subscription presence without exporting its endpoint", async () => {
    environment();
    expect(await notificationDeviceStatus()).toEqual({
      supported: true,
      permission: "granted",
      ready: true,
      subscribed: true,
    });
  });
  it("does not prompt or start a worker when permission was not granted", async () => {
    const e = environment("denied");
    await expect(testNotificationDisplay()).rejects.toThrow("請先啟用網頁推播");
    expect(e.getRegistration).not.toHaveBeenCalled();
  });
  it("requires the matching worker response and never interprets acceptance as user observation", async () => {
    const e = environment();
    const result = testNotificationDisplay();
    await vi.waitFor(() => expect(e.postMessage).toHaveBeenCalledOnce());
    const requestId = e.postMessage.mock.calls[0][0].requestId;
    const attempt = {
      source: "test",
      state: "accepted",
      attemptedAt: new Date().toISOString(),
      notificationPresent: true,
    };
    e.port1.onmessage!({ data: { requestId: "other", attempt } });
    expect(e.port1.close).not.toHaveBeenCalled();
    e.port1.onmessage!({ data: { requestId, attempt } });
    expect(await result).toEqual(attempt);
    expect(e.port1.close).toHaveBeenCalledOnce();
    expect(e.port2.close).toHaveBeenCalledOnce();
  });
  it("bounds a non-responsive or old worker and closes its message ports", async () => {
    vi.useFakeTimers();
    const e = environment();
    const result = expect(testNotificationDisplay()).rejects.toThrow(
      "背景通知沒有回應",
    );
    await vi.advanceTimersByTimeAsync(8000);
    await result;
    expect(e.port1.close).toHaveBeenCalledOnce();
  });
  it("rejects malformed or raw failure reports", () => {
    expect(
      isNotificationAttempt({
        source: "push",
        state: "received",
        attemptedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(
      isNotificationAttempt({
        source: "push",
        state: "failed",
        attemptedAt: new Date().toISOString(),
        errorCode: "private details",
      }),
    ).toBe(false);
  });
});
