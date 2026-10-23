import { revokeWebPushToken } from "./web-push";

/** Keep new token creation behind actual provider cleanup, even if its UI wait
 * expires. Firebase's deleteToken cannot be aborted by a transport deadline. */
export class PushTokenLifecycle {
  private revocation: Promise<unknown> | null = null;

  supportsCoordination() {
    return typeof navigator !== "undefined" && !!navigator.locks?.request;
  }

  async exclusive<T>(work: () => Promise<T>, assertCurrent: () => void) {
    if (!this.supportsCoordination())
      throw new Error(
        "此瀏覽器無法安全協調網頁推播，請更新瀏覽器；站內提醒仍可使用。",
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      return await navigator.locks.request(
        "yaozhitong-push-token",
        { signal: controller.signal },
        async () => {
          clearTimeout(timer);
          assertCurrent();
          // Return the real SDK/HTTP operation, not its shorter UI deadline.
          // The browser keeps this origin-wide lock until it actually settles.
          return work();
        },
      );
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          "其他分頁正在更新推播，請稍後再啟用；站內提醒仍可使用。",
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  revoke(work: () => Promise<unknown>, isCurrent: () => boolean) {
    const previous = this.revocation;
    const operation = Promise.resolve().then(async () => {
      if (previous) await previous.catch(() => {});
      if (isCurrent()) return work();
    });
    this.revocation = operation;
    const clear = () => {
      if (this.revocation === operation) this.revocation = null;
    };
    void operation.then(clear, clear);
    return revokeWebPushToken(() => operation);
  }

  async beforeRegister(assertCurrent: () => void) {
    assertCurrent();
    while (this.revocation) {
      const pending = this.revocation;
      const completed = await revokeWebPushToken(() => pending);
      assertCurrent();
      if (!completed)
        throw new Error("推播清理尚未完成，請稍後再啟用這台裝置的推播。");
    }
    assertCurrent();
  }
}
