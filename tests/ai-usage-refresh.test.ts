import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setTokenProvider } from "../src/api";
import { onAiUsageChanged } from "../src/ai-usage-events";

let stop = () => {};
beforeEach(() => {
  vi.stubGlobal("navigator", { onLine: true });
  setTokenProvider(async () => "synthetic-token");
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

describe("quota display refresh after AI requests", () => {
  it.each([202, 429, 503].flatMap((status) =>
    ["/recognitions", "/explanations"].map((path) => ({ status, path })),
  ))(
    "refreshes server counters after $path returns $status",
    async ({ status, path }) => {
      const update = vi.fn();
      stop = onAiUsageChanged(update);
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json(
              status === 202
                ? { jobId: "synthetic-job" }
                : {
                    code:
                      status === 429 ? "quota_exceeded" : "queue_unavailable",
                    message: "Synthetic",
                  },
              { status },
            ),
          ),
      );
      await api(path, "POST", { image: "synthetic" }).catch(
        () => {},
      );
      expect(update).toHaveBeenCalledOnce();
    },
  );

  it("refreshes after an ambiguous lost response without guessing a new count", async () => {
    const update = vi.fn();
    stop = onAiUsageChanged(update);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("lost response")),
    );
    await expect(api("/bundles", "POST", {})).rejects.toMatchObject({
      code: "network_error",
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not refresh recursively on quota reads or ordinary edits", async () => {
    const update = vi.fn();
    stop = onAiUsageChanged(update);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({})),
    );
    await api("/ai/usage");
    await api("/medications", "POST", {});
    await api("/recognitions/synthetic/medications/0", "POST", {});
    expect(update).not.toHaveBeenCalled();
  });
});
