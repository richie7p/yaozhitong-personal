import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setTokenProvider } from "../src/api";

describe("API failures that can interrupt a demonstration", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { onLine: true });
    setTokenProvider(async () => "");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a stopped service in Chinese instead of a raw fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(api("/medications")).rejects.toMatchObject({
      code: "network_error",
      message: expect.stringContaining("藥智通服務已啟動"),
    });
  });

  it("handles an HTML gateway error without exposing a JSON parse failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Unavailable</html>", {
          status: 503,
          headers: { "X-Request-Id": "request-for-support" },
        }),
      ),
    );
    await expect(api("/medications")).rejects.toMatchObject({
      code: "invalid_response",
      requestId: "request-for-support",
      message: "服務暫時無法回應，請稍後重試。",
    });
  });

  it("keeps structured server error details for retry and support", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: "stale_content",
            message: "資料已更新",
            requestId: "r1",
          },
          { status: 409 },
        ),
      ),
    );
    await expect(
      api("/learning/id/answers", "POST", { answers: {} }),
    ).rejects.toMatchObject({
      code: "stale_content",
      message: "資料已更新",
      requestId: "r1",
    });
  });

  it("rejects offline writes before attempting a request", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(api("/dose-logs", "POST", {})).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not register a device if logout starts during token refresh", async () => {
    let active = true;
    let finishToken!: (token: string) => void;
    setTokenProvider(() => new Promise((resolve) => (finishToken = resolve)));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const pending = api(
      "/devices",
      "POST",
      { token: "synthetic-push-token" },
      undefined,
      () => {
        if (!active) throw new Error("synthetic-session-changed");
      },
    );
    active = false;
    finishToken("synthetic-identity-token");
    await expect(pending).rejects.toThrow("synthetic-session-changed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not return a late device result for a different login session", async () => {
    let active = true;
    let finishResponse!: (response: Response) => void;
    const fetch = vi.fn(
      () => new Promise<Response>((resolve) => (finishResponse = resolve)),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = api(
      "/devices",
      "POST",
      { token: "synthetic-push-token" },
      undefined,
      () => {
        if (!active) throw new Error("synthetic-session-changed");
      },
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    active = false;
    finishResponse(Response.json({ id: "synthetic-device-id" }));
    await expect(pending).rejects.toThrow("synthetic-session-changed");
  });
});
