import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadGoogleIdentity,
  mountGoogleSignInButton,
} from "../src/google-identity";

class FakeScript extends EventTarget {
  src = "";
  async = false;
  defer = false;
  remove = vi.fn();
}

function environment(loaded = true, width = 320) {
  const initialize = vi.fn();
  const renderButton = vi.fn();
  const identity = { initialize, renderButton };
  const view: { google?: { accounts: { id: typeof identity } } } = {};
  const scripts: FakeScript[] = [];
  const document = {
    defaultView: view,
    createElement: vi.fn(() => new FakeScript()),
    head: {
      appendChild: vi.fn((script: FakeScript) => scripts.push(script)),
    },
  } as unknown as Document;
  const element = {
    ownerDocument: document,
    replaceChildren: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ width })),
  } as unknown as HTMLElement;
  const install = () => (view.google = { accounts: { id: identity } });
  if (loaded) install();
  const options = {
    clientId: "123-test.apps.googleusercontent.com",
    onCredential: vi.fn<(token: string) => Promise<void>>().mockResolvedValue(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    isDisabled: vi.fn(() => false),
  };
  const state = () => renderButton.mock.calls.at(-1)![1].state as string;
  const respond = (credential: unknown, responseState: unknown = state()) =>
    initialize.mock.calls[0][0].callback({
      credential,
      state: responseState,
    });
  return {
    identity,
    document,
    element,
    options,
    scripts,
    install,
    initialize,
    renderButton,
    state,
    respond,
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GIS script loading", () => {
  it("loads only the official library once for concurrent consumers", async () => {
    const e = environment(false);
    const first = loadGoogleIdentity(e.document);
    const second = loadGoogleIdentity(e.document);
    expect(second).toBe(first);
    expect(e.scripts).toHaveLength(1);
    expect(e.scripts[0]).toMatchObject({
      src: "https://accounts.google.com/gsi/client?hl=zh_TW",
      async: true,
      defer: true,
    });
    e.install();
    e.scripts[0].dispatchEvent(new Event("load"));
    expect(await first).toBe(e.identity);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails after 15 seconds and permits a fresh load on retry", async () => {
    const e = environment(false);
    const rejected = expect(loadGoogleIdentity(e.document)).rejects.toThrow(
      "載入失敗",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(e.scripts[0].remove).toHaveBeenCalledOnce();
    const retry = loadGoogleIdentity(e.document);
    expect(e.scripts).toHaveLength(2);
    e.install();
    e.scripts[1].dispatchEvent(new Event("load"));
    expect(await retry).toBe(e.identity);
  });

  it("reports script network errors without exposing raw event details", async () => {
    const e = environment(false);
    const failed = expect(loadGoogleIdentity(e.document)).rejects.toThrow(
      "Google 登入按鈕載入失敗",
    );
    e.scripts[0].dispatchEvent(new Event("error"));
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a loaded script that does not expose the expected API", async () => {
    const e = environment(false);
    const failed = expect(loadGoogleIdentity(e.document)).rejects.toThrow(
      "載入失敗",
    );
    e.scripts[0].dispatchEvent(new Event("load"));
    await failed;
  });
});

describe("GIS button lifecycle", () => {
  it("renders the official localized button without One Tap or extra scopes", async () => {
    const e = environment();
    const dispose = mountGoogleSignInButton(e.element, e.options);
    await flush();
    expect(e.initialize).toHaveBeenCalledOnce();
    expect(e.initialize.mock.calls[0][0]).toEqual({
      client_id: e.options.clientId,
      auto_select: false,
      button_auto_select: false,
      ux_mode: "popup",
      callback: expect.any(Function),
    });
    expect(e.renderButton.mock.calls[0][1]).toMatchObject({
      type: "standard",
      locale: "zh_TW",
      width: 320,
      state: expect.any(String),
    });
    expect(e.options.onStatus.mock.calls.flat()).toEqual(["loading", "ready"]);
    expect(e.options.onCredential).not.toHaveBeenCalled();
    dispose();
  });

  it("caps desktop width and respects a narrower mobile container", async () => {
    const wide = environment(true, 900);
    const narrow = environment(true, 244);
    const stopWide = mountGoogleSignInButton(wide.element, wide.options);
    const stopNarrow = mountGoogleSignInButton(narrow.element, narrow.options);
    await flush();
    expect(wide.renderButton.mock.calls[0][1].width).toBe(400);
    expect(narrow.renderButton.mock.calls[0][1].width).toBe(244);
    stopWide();
    stopNarrow();
  });

  it("does not initialize or render a disposed StrictMode mount", async () => {
    const e = environment(false);
    const first = { ...e.options, onStatus: vi.fn(), onCredential: vi.fn() };
    const stopFirst = mountGoogleSignInButton(e.element, first);
    stopFirst();
    const stopSecond = mountGoogleSignInButton(e.element, e.options);
    e.install();
    e.scripts[0].dispatchEvent(new Event("load"));
    await flush();
    expect(e.scripts).toHaveLength(1);
    expect(e.initialize).toHaveBeenCalledOnce();
    expect(e.renderButton).toHaveBeenCalledOnce();
    e.respond("synthetic-google-token");
    await flush();
    expect(first.onCredential).not.toHaveBeenCalled();
    expect(e.options.onCredential).toHaveBeenCalledOnce();
    stopSecond();
  });

  it("ignores stale button responses after remount and initializes GIS once", async () => {
    const e = environment();
    const oldReceiver = vi.fn();
    const stopOld = mountGoogleSignInButton(e.element, {
      ...e.options,
      onCredential: oldReceiver,
    });
    await flush();
    const oldState = e.state();
    stopOld();
    const stopNew = mountGoogleSignInButton(e.element, e.options);
    await flush();
    expect(e.state()).not.toBe(oldState);
    e.respond("stale-synthetic-token", oldState);
    e.respond("missing-state-token", null);
    await flush();
    expect(oldReceiver).not.toHaveBeenCalled();
    expect(e.options.onCredential).not.toHaveBeenCalled();
    e.respond("current-synthetic-token");
    await flush();
    expect(e.options.onCredential).toHaveBeenCalledExactlyOnceWith(
      "current-synthetic-token",
    );
    expect(e.initialize).toHaveBeenCalledOnce();
    stopNew();
  });

  it("processes a credential once even if GIS calls back again during or after login", async () => {
    const e = environment();
    let resolve!: () => void;
    e.options.onCredential.mockImplementation(
      () => new Promise<void>((done) => (resolve = done)),
    );
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("synthetic-token");
    e.respond("synthetic-token");
    await flush();
    expect(e.options.onCredential).toHaveBeenCalledOnce();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("busy");
    resolve();
    await flush();
    e.respond("synthetic-token");
    await flush();
    expect(e.options.onCredential).toHaveBeenCalledOnce();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("complete");
    stop();
  });

  it("rejects a missing credential with a visible recoverable error", async () => {
    const e = environment();
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("");
    expect(e.options.onCredential).not.toHaveBeenCalled();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("error");
    expect(e.options.onError).toHaveBeenCalledWith(
      expect.stringContaining("電子信箱"),
    );
    stop();
  });

  it("ignores a credential while the current login form is disabled", async () => {
    const e = environment();
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.options.isDisabled.mockReturnValue(true);
    e.respond("synthetic-token");
    await flush();
    expect(e.options.onCredential).not.toHaveBeenCalled();
    stop();
  });

  it("does not start a credential handler if unmounted before its microtask", async () => {
    const e = environment();
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("synthetic-token");
    stop();
    await flush();
    expect(e.options.onCredential).not.toHaveBeenCalled();
  });

  it("suppresses stale async completion or failure UI after unmount", async () => {
    const e = environment();
    let reject!: (error: Error) => void;
    e.options.onCredential.mockImplementation(
      () => new Promise<void>((_, fail) => (reject = fail)),
    );
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("synthetic-token");
    await flush();
    stop();
    reject(new Error("sensitive-provider-error"));
    await flush();
    expect(e.options.onError).not.toHaveBeenCalled();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("busy");
  });

  it("sanitizes a login failure and accepts a new explicit retry mount", async () => {
    const e = environment();
    e.options.onCredential.mockRejectedValueOnce(
      new Error("sensitive-provider-error"),
    );
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("synthetic-token");
    await flush();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("error");
    expect(e.options.onError.mock.calls.flat().join()).not.toContain("sensitive");
    stop();
    const retry = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("synthetic-retry-token");
    await flush();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("complete");
    retry();
  });

  it("does not silently reset GIS to another client ID", async () => {
    const e = environment();
    const first = mountGoogleSignInButton(e.element, e.options);
    await flush();
    first();
    const second = mountGoogleSignInButton(e.element, {
      ...e.options,
      clientId: "456-other.apps.googleusercontent.com",
    });
    await flush();
    expect(e.initialize).toHaveBeenCalledOnce();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("error");
    second();
  });

  it("fails closed for invalid configuration before loading any script", async () => {
    const e = environment(false);
    const stop = mountGoogleSignInButton(e.element, {
      ...e.options,
      clientId: "",
    });
    await flush();
    expect(e.scripts).toHaveLength(0);
    expect(e.options.onStatus).toHaveBeenLastCalledWith("error");
    stop();
  });

  it("stops rendering and rejects credentials if the official button throws", async () => {
    const e = environment();
    e.renderButton.mockImplementation(() => {
      throw new Error("render-failure");
    });
    const stop = mountGoogleSignInButton(e.element, e.options);
    await flush();
    e.respond("synthetic-token");
    await flush();
    expect(e.options.onCredential).not.toHaveBeenCalled();
    expect(e.options.onStatus).toHaveBeenLastCalledWith("error");
    stop();
  });
});
