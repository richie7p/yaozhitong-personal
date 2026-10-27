import { afterEach, describe, expect, it, vi } from "vitest";
import { PushTokenLifecycle } from "../src/push-session";

afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("push token session transitions", () => {
  it("skips an old logout provider call when another session has already signed in", async () => {
    const lifecycle = new PushTokenLifecycle(),
      remove = vi.fn(async () => {});
    let current = true;
    const removing = lifecycle.revoke(remove, () => current);
    current = false;
    expect(await removing).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    await expect(lifecycle.beforeRegister(() => {})).resolves.toBeUndefined();
  });

  it("keeps a new registration behind cleanup that already started in the previous session", async () => {
    const lifecycle = new PushTokenLifecycle(),
      gate = deferred();
    const calls: string[] = [];
    const removing = lifecycle.revoke(
      async () => {
        calls.push("delete-start");
        await gate.promise;
        calls.push("delete-finish");
      },
      () => true,
    );
    await vi.waitFor(() => expect(calls).toEqual(["delete-start"]));
    const registering = lifecycle
      .beforeRegister(() => {})
      .then(() => calls.push("new-token"));
    await Promise.resolve();
    expect(calls).toEqual(["delete-start"]);
    gate.resolve();
    await Promise.all([removing, registering]);
    expect(calls).toEqual(["delete-start", "delete-finish", "new-token"]);
  });

  it("does not clear the actual cleanup barrier when its bounded wait times out", async () => {
    vi.useFakeTimers();
    const lifecycle = new PushTokenLifecycle(),
      gate = deferred();
    const removing = lifecycle.revoke(
      () => gate.promise,
      () => true,
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(await removing).toBe(false);
    const create = vi.fn();
    const blocked = lifecycle.beforeRegister(() => {}).then(create);
    const rejected = expect(blocked).rejects.toThrow("推播清理尚未完成");
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(create).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.resolve();
    await lifecycle.beforeRegister(() => {});
    create();
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects a registration whose identity changes while cleanup is in progress", async () => {
    const lifecycle = new PushTokenLifecycle(),
      gate = deferred();
    const removing = lifecycle.revoke(
      () => gate.promise,
      () => true,
    );
    let current = true;
    const registering = lifecycle.beforeRegister(() => {
      if (!current) throw new Error("identity changed");
    });
    const rejected = expect(registering).rejects.toThrow("identity changed");
    current = false;
    gate.resolve();
    await removing;
    await rejected;
  });

  it("serializes cleanup requests and checks ownership when each provider call actually starts", async () => {
    const lifecycle = new PushTokenLifecycle(),
      gate = deferred();
    const first = lifecycle.revoke(
      () => gate.promise,
      () => true,
    );
    let current = true;
    const secondCall = vi.fn(async () => {});
    const second = lifecycle.revoke(secondCall, () => current);
    const registering = lifecycle.beforeRegister(() => {});
    current = false;
    gate.resolve();
    await Promise.all([first, second, registering]);
    expect(secondCall).not.toHaveBeenCalled();
  });
});
