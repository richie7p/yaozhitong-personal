import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWebPushToken, revokeWebPushToken } from "../src/web-push";

function dependencies() {
  return {
    secureContext: true,
    browserSupported: true,
    vapidKey: "synthetic-public-vapid",
    permission: "default" as NotificationPermission,
    requestPermission: vi.fn(async () => "granted" as NotificationPermission),
    isSupported: vi.fn(async () => true),
    register: vi.fn(async () => ({}) as ServiceWorkerRegistration),
    getToken: vi.fn(async () => "synthetic-registration-token"),
  };
}
afterEach(() => vi.useRealTimers());

describe("web push setup recovery", () => {
  it("requests permission in the original user gesture before async support checks", async () => {
    const d = dependencies();
    const result = requestWebPushToken(d);
    expect(d.requestPermission).toHaveBeenCalledOnce();
    expect(d.isSupported).not.toHaveBeenCalled();
    await expect(result).resolves.toBe("synthetic-registration-token");
    expect(d.register).toHaveBeenCalledOnce();
    expect(d.getToken).toHaveBeenCalledWith(await d.register.mock.results[0].value);
  });

  it("does not reprompt an already granted browser", async () => {
    const d = dependencies();
    d.permission = "granted";
    await requestWebPushToken(d);
    expect(d.requestPermission).not.toHaveBeenCalled();
  });

  it.each(["denied", "default"] as NotificationPermission[])(
    "does not register when the user answers %s",
    async (permission) => {
      const d = dependencies();
      d.requestPermission.mockResolvedValue(permission);
      await expect(requestWebPushToken(d)).rejects.toThrow("未授權推播");
      expect(d.register).not.toHaveBeenCalled();
      expect(d.getToken).not.toHaveBeenCalled();
    },
  );

  it("explains blocked notifications without reopening the prompt", async () => {
    const d = dependencies();
    d.permission = "denied";
    await expect(requestWebPushToken(d)).rejects.toThrow("通知已被瀏覽器封鎖");
    expect(d.requestPermission).not.toHaveBeenCalled();
  });

  it.each(["secureContext", "browserSupported"] as const)(
    "rejects missing %s before any browser prompt or SDK work",
    async (property) => {
      const d = dependencies();
      d[property] = false;
      await expect(requestWebPushToken(d)).rejects.toThrow("加入主畫面");
      expect(d.requestPermission).not.toHaveBeenCalled();
      expect(d.isSupported).not.toHaveBeenCalled();
    },
  );

  it("does not prompt when the site's VAPID setting is absent", async () => {
    const d = dependencies();
    d.vapidKey = "";
    await expect(requestWebPushToken(d)).rejects.toThrow("尚未完成推播設定");
    expect(d.requestPermission).not.toHaveBeenCalled();
  });

  it("rejects an unsupported SDK environment without registering a worker", async () => {
    const d = dependencies();
    d.isSupported.mockResolvedValue(false);
    await expect(requestWebPushToken(d)).rejects.toThrow("不支援網頁推播");
    expect(d.register).not.toHaveBeenCalled();
  });

  it("stops after a dismissed or stalled permission prompt even if it later grants", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    let complete!: (permission: NotificationPermission) => void;
    d.requestPermission.mockImplementation(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const result = expect(requestWebPushToken(d)).rejects.toThrow(
      "等待通知授權逾時",
    );
    await vi.advanceTimersByTimeAsync(30000);
    await result;
    complete("granted");
    await vi.runAllTimersAsync();
    expect(d.isSupported).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
    expect(d.getToken).not.toHaveBeenCalled();
  });

  it("does not continue to FCM after delayed service worker registration times out", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    let complete!: (registration: ServiceWorkerRegistration) => void;
    d.register.mockImplementation(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const result = expect(requestWebPushToken(d)).rejects.toThrow(
      "準備背景通知逾時",
    );
    await vi.advanceTimersByTimeAsync(30000);
    await result;
    complete({} as ServiceWorkerRegistration);
    await vi.runAllTimersAsync();
    expect(d.getToken).not.toHaveBeenCalled();
  });

  it("a stalled FCM response times out and permits a later separate retry", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    let complete!: (token: string) => void;
    d.getToken.mockImplementationOnce(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const result = expect(requestWebPushToken(d)).rejects.toThrow(
      "連線推播服務逾時",
    );
    await vi.advanceTimersByTimeAsync(30000);
    await result;
    complete("late-token");
    await vi.runAllTimersAsync();
    await expect(requestWebPushToken(d)).resolves.toBe(
      "synthetic-registration-token",
    );
  });

  it("does not pass an empty FCM token to device registration", async () => {
    const d = dependencies();
    d.getToken.mockResolvedValue("");
    await expect(requestWebPushToken(d)).rejects.toThrow("未取得推播裝置憑證");
  });

  it("clears its deadline after an SDK error so a later retry can succeed", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    d.getToken.mockRejectedValueOnce(new Error("synthetic-network-failure"));
    await expect(requestWebPushToken(d)).rejects.toThrow(
      "synthetic-network-failure",
    );
    expect(vi.getTimerCount()).toBe(0);
    await expect(requestWebPushToken(d)).resolves.toBe(
      "synthetic-registration-token",
    );
  });

  it("does not advance permission or token results after the session changes", async () => {
    const d = dependencies();
    let current = true;
    let complete!: (permission: NotificationPermission) => void;
    d.requestPermission.mockImplementation(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const result = requestWebPushToken({
      ...d,
      assertIdentity: () => {
        if (!current) throw new Error("synthetic-session-changed");
      },
    });
    current = false;
    complete("granted");
    await expect(result).rejects.toThrow("synthetic-session-changed");
    expect(d.isSupported).not.toHaveBeenCalled();
    expect(d.getToken).not.toHaveBeenCalled();
  });

  it("rejects a late FCM token after logout instead of returning it for storage", async () => {
    const d = dependencies();
    let current = true;
    let complete!: (token: string) => void;
    d.getToken.mockImplementation(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const result = requestWebPushToken({
      ...d,
      assertIdentity: () => {
        if (!current) throw new Error("synthetic-session-changed");
      },
    });
    await vi.waitFor(() => expect(d.getToken).toHaveBeenCalledOnce());
    current = false;
    complete("late-synthetic-token");
    await expect(result).rejects.toThrow("synthetic-session-changed");
  });

  it("allows logout to finish when provider revocation stalls", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn(() => new Promise(() => {}));
    const result = revokeWebPushToken(revoke);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toBe(false);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("clears the logout deadline after successful revocation", async () => {
    vi.useFakeTimers();
    await expect(revokeWebPushToken(async () => {})).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
