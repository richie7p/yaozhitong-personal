import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setJobIdentity, setTokenProvider } from "../src/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { onLine: true });
  setTokenProvider(async () => "synthetic-token");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded API transport recovery", () => {
  it("recovers one disconnected read with distinct opaque correlation and no extra total budget", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic disconnect"))
      .mockResolvedValueOnce(Response.json({ items: ["recovered"] }));
    vi.stubGlobal("fetch", request);
    await expect(api("/notifications")).resolves.toEqual({
      items: ["recovered"],
    });
    expect(request).toHaveBeenCalledTimes(2);
    const ids = request.mock.calls
      .map((call) => (call[1] as RequestInit).headers as Record<string, string>)
      .map((headers) => headers["X-Client-Request-Id"]);
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops after two read transport failures and exposes the failed request correlation", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new TypeError("synthetic disconnect"));
    vi.stubGlobal("fetch", request);
    await expect(api("/notifications")).rejects.toMatchObject({
      code: "network_error",
      phase: "headers",
      attempts: 2,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not replay a mutation or retry a server refusal", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic disconnect"))
      .mockResolvedValueOnce(
        Response.json(
          { code: "quota_exceeded", message: "quota" },
          { status: 429 },
        ),
      );
    vi.stubGlobal("fetch", request);
    await expect(
      api("/cabinet", "POST", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "network_error", attempts: 1 });
    await expect(api("/notifications")).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 429,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not retry or return old account data after an identity switch", async () => {
    const first = deferred<Response>();
    const request = vi.fn(() => first.promise);
    vi.stubGlobal("fetch", request);
    const pending = api("/notifications");
    await vi.advanceTimersByTimeAsync(0);
    setJobIdentity("synthetic-switched-owner");
    first.resolve(Response.json({ items: ["previous-account"] }));
    await expect(pending).rejects.toMatchObject({ code: "identity_changed" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("returns control and aborts a silent fetch instead of waiting indefinitely", async () => {
    const stalled = deferred<Response>();
    const fetchMock = vi.fn(() => stalled.promise);
    vi.stubGlobal("fetch", fetchMock);
    const request = api("/jobs/synthetic");
    const rejected = expect(request).rejects.toMatchObject({
      code: "request_timeout",
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(45000);
    await rejected;
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal
        ?.aborted,
    ).toBe(true);
    // Some transports ignore cancellation. A late success cannot change the
    // already-failed request or leave an unhandled rejection.
    stalled.resolve(Response.json({ status: "succeeded" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled response body after headers have arrived", async () => {
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    const fetchMock = vi.fn(async () => ({ ok: true, json }));
    vi.stubGlobal("fetch", fetchMock);
    const request = api("/me");
    const rejected = expect(request).rejects.toMatchObject({
      code: "request_timeout",
    });
    await vi.advanceTimersByTimeAsync(45000);
    await rejected;
    expect(json).toHaveBeenCalledOnce();
    body.resolve({ id: "late-synthetic-account" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never sends private input when token refresh completes after timeout", async () => {
    const token = deferred<string>();
    const fetchMock = vi.fn();
    setTokenProvider(() => token.promise);
    vi.stubGlobal("fetch", fetchMock);
    const request = api("/bundles", "POST", {
      medicationIds: ["synthetic-private-input"],
    });
    const rejected = expect(request).rejects.toMatchObject({
      code: "request_timeout",
    });
    await vi.advanceTimersByTimeAsync(45000);
    await rejected;
    token.resolve("late-synthetic-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a larger photo upload budget while bounding it at ninety seconds", async () => {
    const stalled = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => stalled.promise),
    );
    const request = api("/recognitions", "POST", { image: "synthetic" });
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(request).rejects.toMatchObject({
      code: "request_timeout",
    });
    await vi.advanceTimersByTimeAsync(45000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(45000);
    await rejected;
    expect(settled).toBe(true);
  });

  it("clears the deadline on normal success or a structured server failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json(
          { code: "not_found", message: "找不到資料。" },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(api("/me")).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    await expect(api("/medications/missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
