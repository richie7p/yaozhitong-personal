import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_READ_PATHS,
  LoadMetrics,
  LoadPlanSchema,
  measuredRequest,
  percentile,
  runVirtualUsers,
} from "../tools/load-core";

afterEach(() => vi.unstubAllGlobals());

const cloud = {
  schema: "yzt-load-plan/v1",
  mode: "cloud-readonly",
  project: "project-b6fe4904-e687-4365-b2f",
  origin: "https://project-b6fe4904-e687-4365-b2f.firebaseapp.com",
  profiles: [{ virtualUsers: 8, requests: 60, thinkTimeMs: 100 }],
  requestTimeoutMs: 15000,
  stopP95Ms: 10000,
  stopServerErrorRate: 0.05,
};
describe("bounded load accounting", () => {
  it("distinguishes a pre-header disconnect from a response-body failure with exact opaque request IDs", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("synthetic headers disconnect"))
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ "X-Request-Id": "server-correlation" }),
        text: async () => {
          throw new TypeError("synthetic body disconnect");
        },
      });
    vi.stubGlobal("fetch", request);
    const metrics = new LoadMetrics({
      stopP95Ms: 1000,
      stopServerErrorRate: 0.05,
    });
    for (let i = 0; i < 2; i++)
      await measuredRequest(metrics, "http://127.0.0.1:18095", {
        label: "GET /notifications",
        path: "/notifications",
        timeoutMs: 1000,
      });
    expect(metrics.summary().failures).toMatchObject([
      {
        status: 0,
        phase: "headers",
        error: "network_error",
        requestId: expect.any(String),
        traceId: expect.any(String),
      },
      {
        status: 200,
        phase: "body",
        error: "network_error",
        serverRequestId: "server-correlation",
        headersMs: expect.any(Number),
      },
    ]);
    const first = request.mock.calls[0][1] as RequestInit;
    const headers = first.headers as Record<string, string>;
    expect(headers["X-Cloud-Trace-Context"]).toBe(
      metrics.samples[0].traceId + "/1;o=1",
    );
    expect(headers["X-Client-Request-Id"]).toBe(metrics.samples[0].requestId);
    expect(metrics.summary().transportErrors).toBe(2);
  });
  it("uses nearest rank percentiles without mutating samples", () => {
    const values = [9, 1, 2, 5];
    expect(percentile(values, 0.5)).toBe(2);
    expect(percentile(values, 0.95)).toBe(9);
    expect(values).toEqual([9, 1, 2, 5]);
    expect(percentile([], 0.5)).toBe(0);
  });
  it("does not let concurrent users exceed a shared exact request budget", async () => {
    let calls = 0,
      inFlight = 0,
      maximum = 0;
    const perUser = Array(8).fill(0);
    const issued = await runVirtualUsers(
      8,
      60,
      () => false,
      async (user) => {
        perUser[user]++;
        calls++;
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    );
    expect(calls).toBe(60);
    expect(issued).toBe(60);
    expect(maximum).toBe(8);
    expect(perUser).toEqual([8, 8, 8, 8, 7, 7, 7, 7]);
  });
  it("drains existing work but stops issuing requests once an invariant fails", async () => {
    let calls = 0,
      stop = false;
    await runVirtualUsers(
      8,
      1000,
      () => stop,
      async () => {
        calls++;
        stop = true;
      },
    );
    expect(calls).toBe(1);
  });
  it("counts expected quota and access refusals separately from actual failures", () => {
    const m = new LoadMetrics({ stopP95Ms: 1000, stopServerErrorRate: 0.05 });
    for (let i = 0; i < 20; i++)
      m.record({
        label: "boundary",
        milliseconds: 3,
        status: 429,
        expected: true,
        bytes: 20,
      });
    expect(m.summary()).toMatchObject({
      expectedRejections: 20,
      unexpectedResponses: 0,
      stopReason: null,
    });
    m.record({
      label: "bad",
      milliseconds: 3,
      status: 500,
      expected: false,
      bytes: 20,
    });
    m.record({
      label: "bad",
      milliseconds: 3,
      status: 500,
      expected: false,
      bytes: 20,
    });
    expect(m.summary().stopReason).toBe(
      "server_or_transport_error_rate_exceeded",
    );
  });
  it("stops on body transport failures even when successful HTTP headers already arrived", () => {
    const m = new LoadMetrics({ stopP95Ms: 1000, stopServerErrorRate: 0.05 });
    for (let i = 0; i < 9; i++)
      m.record({
        label: "read",
        milliseconds: 3,
        status: 200,
        expected: true,
        bytes: 12,
      });
    m.record({
      label: "read",
      milliseconds: 3,
      status: 200,
      expected: false,
      bytes: 0,
      phase: "body",
      error: "request_timeout",
    });
    expect(m.summary()).toMatchObject({
      requests: 10,
      transportErrors: 1,
      serverErrors: 0,
      unexpectedResponses: 1,
      stopReason: "server_or_transport_error_rate_exceeded",
    });
  });
  it("cloud mode rejects mutations in configuration, extra capacity and alternate origins", () => {
    expect(LoadPlanSchema.parse(cloud).profiles[0].requests).toBe(60);
    for (const change of [
      { origin: "https://example.test" },
      { profiles: [{ virtualUsers: 100, requests: 60, thinkTimeMs: 0 }] },
      { profiles: [{ virtualUsers: 8, requests: 61, thinkTimeMs: 0 }] },
      { stopP95Ms: 11000 },
      { origin: cloud.origin + "/?token=bad" },
    ])
      expect(() => LoadPlanSchema.parse({ ...cloud, ...change })).toThrow();
    expect(
      CLOUD_READ_PATHS.every(
        (p) => !p.includes("admin") && !p.includes("export"),
      ),
    ).toBe(true);
  });
  it("local mode cannot accidentally point the official adapter at a real project", () => {
    expect(() =>
      LoadPlanSchema.parse({
        ...cloud,
        mode: "emulator",
        origin: "http://127.0.0.1:18095",
      }),
    ).toThrow();
    expect(
      LoadPlanSchema.parse({
        ...cloud,
        mode: "emulator",
        project: "demo-yzt-load-20261023",
        origin: "http://127.0.0.1:18095",
      }).mode,
    ).toBe("emulator");
  });
  it("a throwing output check cannot turn malformed responses into a green load result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ unexpected: true })),
    );
    const metrics = new LoadMetrics({
      stopP95Ms: 1000,
      stopServerErrorRate: 0.05,
    });
    const response = await measuredRequest(metrics, "http://127.0.0.1:18095", {
      label: "format",
      path: "/me",
      timeoutMs: 1000,
      invariant: (b) => b.account.id === "expected",
    });
    expect(response.expected).toBe(false);
    expect(metrics.summary()).toMatchObject({
      requests: 1,
      unexpectedResponses: 1,
      invariantFailures: 1,
      stopReason: "invariant_failed",
    });
  });
});
