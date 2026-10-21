import { webcrypto } from "node:crypto";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_JOB_STORAGE_KEY } from "../src/pending-jobs";

let client: typeof import("../src/api");
let stored: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

function response(value: unknown, status = 200) {
  return Response.json(value, { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function postKeys() {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => new Headers(init.headers).get("Idempotency-Key"));
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  promise.then(
    (value) => {
      result = { value };
    },
    (error) => {
      result = { error };
    },
  );
  let clockAdvances = 0;
  const realDeadline = performance.now() + 2000;
  while (!result && clockAdvances < 250 && performance.now() < realDeadline) {
    // WebCrypto uses the real event loop. Waiting for its native thread must
    // not consume the fake-clock budget before a poll/deadline is scheduled.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (result) break;
    if (!vi.getTimerCount()) {
      await realDelay(1);
      continue;
    }
    await vi.advanceTimersByTimeAsync(1800);
    clockAdvances++;
  }
  if (!result && clockAdvances === 250)
    throw Error("Synthetic job did not settle within its polling budget.");
  if (!result)
    throw Error(
      "Synthetic job's real asynchronous preparation did not settle.",
    );
  if ("error" in result) throw result.error;
  return result.value;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  stored = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("crypto", webcrypto);
  fetchMock = vi.fn(async (_url, init) =>
    init?.method === "POST"
      ? response({ jobId: "synthetic-job" }, 202)
      : response({ id: "synthetic-job", status: "succeeded", result: {} }),
  );
  vi.stubGlobal("fetch", fetchMock);
  client = await import("../src/api");
  client.setTokenProvider(async () => "synthetic-token-a");
  client.setJobIdentity("synthetic-account-a");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("recovering an AI operation without creating another job", () => {
  it("rejects an entirely offline operation without fetching or storing pending state", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(
      client.submitJob("/recognitions", { image: "synthetic-photo" }),
    ).rejects.toMatchObject({ code: "offline" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
  });

  it("an offline retry leaves an already ambiguous operation available for recovery", async () => {
    const body = { medicationIds: ["a"] };
    fetchMock.mockRejectedValueOnce(new TypeError("Response lost"));
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "network_error",
    });
    const pending = stored.get(PENDING_JOB_STORAGE_KEY);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "offline",
    });
    expect(stored.get(PENDING_JOB_STORAGE_KEY)).toBe(pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", { onLine: true });
    await settle(client.submitJob("/bundles", body));
    expect(new Set(postKeys()).size).toBe(1);
  });

  it("snapshots the body before asynchronous hashing so later mutations cannot alter its POST", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.stubGlobal("crypto", {
      randomUUID: () => webcrypto.randomUUID(),
      subtle: {
        digest: async (...args: Parameters<typeof digest>) => {
          await gate;
          return digest(...args);
        },
      },
    });
    const body = { medicationIds: ["original-synthetic-med"] };
    const run = client.submitJob("/bundles", body);
    body.medicationIds[0] = "later-mutation";
    release();
    await settle(run);
    const [, request] = fetchMock.mock.calls.find(
      ([, init]) => init.method === "POST",
    )!;
    expect(JSON.parse(request.body)).toEqual({
      medicationIds: ["original-synthetic-med"],
    });
  });

  it("reuses the key after an accepted POST response is lost and charges one synthetic job", async () => {
    const jobs = new Map<string, string>();
    let lost = true;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method !== "POST") return response({ status: "succeeded" });
      const key = new Headers(init.headers).get("Idempotency-Key")!;
      jobs.set(key, jobs.get(key) || "accepted-on-server");
      if (lost) {
        lost = false;
        throw new TypeError("Response lost");
      }
      return response({ jobId: jobs.get(key) }, 202);
    });
    const body = { medicationIds: ["synthetic-med"] };
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "network_error",
    });
    await settle(client.submitJob("/bundles", body));
    expect(postKeys()).toHaveLength(2);
    expect(new Set(postKeys()).size).toBe(1);
    expect(jobs.size).toBe(1);
  });

  it.each(["queue_unavailable", "service_error"])(
    "retains the operation through an ambiguous 503 %s",
    async (code) => {
      fetchMock.mockResolvedValueOnce(
        response({ code, message: "Synthetic unavailable" }, 503),
      );
      await expect(
        client.submitJob("/bundles", { medicationIds: ["a"] }),
      ).rejects.toMatchObject({ code, status: 503 });
      await settle(client.submitJob("/bundles", { medicationIds: ["a"] }));
      expect(new Set(postKeys()).size).toBe(1);
    },
  );

  it("retains the key after an invalid gateway response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Gateway unavailable</html>", { status: 502 }),
    );
    await expect(
      client.submitJob("/recognitions", { image: "synthetic-photo" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await settle(
      client.submitJob("/recognitions", { image: "synthetic-photo" }),
    );
    expect(new Set(postKeys()).size).toBe(1);
  });

  it("resumes the known job after a polling network error without posting again", async () => {
    fetchMock.mockImplementationOnce(async () =>
      response({ jobId: "known-poll-job" }, 202),
    );
    fetchMock.mockRejectedValueOnce(new TypeError("Poll disconnected"));
    const body = { medicationIds: ["a"] };
    await expect(
      settle(client.submitJob("/bundles", body)),
    ).rejects.toMatchObject({ code: "network_error", jobId: "known-poll-job" });
    await settle(client.submitJob("/bundles", body));
    expect(postKeys()).toHaveLength(1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "/api/v1/jobs/known-poll-job",
    );
  });

  it("reuses the operation after a silent POST timeout and ignores its late response", async () => {
    const first = deferred<Response>();
    fetchMock.mockImplementationOnce(() => first.promise);
    const body = { medicationIds: ["synthetic-timeout-med"] };
    await expect(
      settle(client.submitJob("/bundles", body)),
    ).rejects.toMatchObject({ code: "request_timeout" });
    expect(stored.get(PENDING_JOB_STORAGE_KEY)).toBeTruthy();
    await settle(client.submitJob("/bundles", body));
    expect(postKeys()).toHaveLength(2);
    expect(new Set(postKeys()).size).toBe(1);
    expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
    first.resolve(response({ jobId: "ignored-late-response" }, 202));
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
  });

  it("resumes a known job after a silent poll timeout without charging a new operation", async () => {
    const poll = deferred<Response>();
    fetchMock.mockResolvedValueOnce(
      response({ jobId: "stalled-poll-job" }, 202),
    );
    fetchMock.mockImplementationOnce(() => poll.promise);
    const body = { medicationIds: ["synthetic-poll-med"] };
    await expect(
      settle(client.submitJob("/bundles", body)),
    ).rejects.toMatchObject({
      code: "request_timeout",
      jobId: "stalled-poll-job",
    });
    await settle(client.submitJob("/bundles", body));
    expect(postKeys()).toHaveLength(1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "/api/v1/jobs/stalled-poll-job",
    );
    expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
  });

  it("retains the 200-poll budget and resumes after timeout without another POST", async () => {
    let completed = false;
    let polls = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === "POST") return response({ jobId: "slow-job" }, 202);
      polls++;
      return response({ status: completed ? "succeeded" : "running" });
    });
    const body = { medicationIds: ["a"] };
    await expect(
      settle(client.submitJob("/bundles", body)),
    ).rejects.toMatchObject({ code: "timeout", jobId: "slow-job" });
    expect(polls).toBe(200);
    completed = true;
    await settle(client.submitJob("/bundles", body));
    expect(polls).toBe(201);
    expect(postKeys()).toHaveLength(1);
  });

  it("coalesces simultaneous matching inputs including reordered object fields", async () => {
    const firstProgress = vi.fn(),
      secondProgress = vi.fn();
    await settle(
      Promise.all([
        client.submitJob(
          "/chat",
          { question: "Synthetic question", medicationIds: ["a"] },
          firstProgress,
        ),
        client.submitJob(
          "/chat",
          { medicationIds: ["a"], question: "Synthetic question" },
          secondProgress,
        ),
      ]),
    );
    expect(postKeys()).toHaveLength(1);
    expect(firstProgress).toHaveBeenCalled();
    expect(secondProgress).toHaveBeenCalled();
  });

  it("coalesces matching callers even when one fingerprint would finish after the other's job", async () => {
    const delayedHashes = deferred<void>();
    let digestCalls = 0;
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.stubGlobal("crypto", {
      randomUUID: () => webcrypto.randomUUID(),
      subtle: {
        digest: async (...args: Parameters<typeof digest>) => {
          // If each caller hashes independently, hold the second caller until
          // the first job has completed and its pending record has been cleared.
          if (++digestCalls > 2) await delayedHashes.promise;
          return digest(...args);
        },
      },
    });
    const firstProgress = vi.fn(),
      secondProgress = vi.fn();
    const first = client.submitJob(
      "/chat",
      { question: "Synthetic delayed-hash question", medicationIds: ["a"] },
      firstProgress,
    );
    const second = client.submitJob(
      "/chat",
      { medicationIds: ["a"], question: "Synthetic delayed-hash question" },
      secondProgress,
    );
    try {
      await settle(first);
      delayedHashes.resolve();
      await settle(second);
      expect(postKeys()).toHaveLength(1);
      expect(firstProgress).toHaveBeenCalled();
      expect(secondProgress).toHaveBeenCalled();
    } finally {
      delayedHashes.resolve();
      await settle(Promise.allSettled([first, second]));
    }
  });

  it("preserves a lost-POST operation over a module reload without persisting health input", async () => {
    const body = {
      image: "private-synthetic-photo-base64",
      mediaType: "image/jpeg",
    };
    fetchMock.mockRejectedValueOnce(new TypeError("POST response lost"));
    await expect(client.submitJob("/recognitions", body)).rejects.toMatchObject(
      { code: "network_error" },
    );
    const saved = stored.get(PENDING_JOB_STORAGE_KEY)!;
    expect(saved).not.toContain(body.image);
    expect(saved).not.toContain("synthetic-account-a");
    expect(saved).not.toContain("image/jpeg");
    vi.resetModules();
    client = await import("../src/api");
    client.setTokenProvider(async () => "synthetic-token-a-refreshed");
    client.setJobIdentity("synthetic-account-a");
    await settle(client.submitJob("/recognitions", body));
    expect(new Set(postKeys()).size).toBe(1);
  });

  it("restores a known jobId over reload and only polls it", async () => {
    const body = { medicationIds: ["a"] };
    fetchMock.mockResolvedValueOnce(response({ jobId: "durable-job" }, 202));
    fetchMock.mockRejectedValueOnce(new TypeError("Poll disconnected"));
    await expect(
      settle(client.submitJob("/bundles", body)),
    ).rejects.toMatchObject({ jobId: "durable-job" });
    vi.resetModules();
    client = await import("../src/api");
    client.setTokenProvider(async () => "synthetic-token-a");
    client.setJobIdentity("synthetic-account-a");
    await settle(client.submitJob("/bundles", body));
    expect(postKeys()).toHaveLength(1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/jobs/durable-job");
  });

  it("uses a different operation for changed input or endpoint", async () => {
    fetchMock.mockRejectedValue(new TypeError("Synthetic disconnected"));
    for (const [path, body] of [
      ["/bundles", { medicationIds: ["a"] }],
      ["/bundles", { medicationIds: ["b"] }],
      ["/chat", { medicationIds: ["a"] }],
    ] as const)
      await expect(client.submitJob(path, body)).rejects.toMatchObject({
        code: "network_error",
      });
    expect(new Set(postKeys()).size).toBe(3);
  });

  it.each(["succeeded", "failed"])(
    "a confirmed %s clears pending state so a later explicit submit is a new operation",
    async (status) => {
      fetchMock.mockImplementation(async (_url, init) =>
        init.method === "POST"
          ? response({ jobId: "terminal-job" }, 202)
          : response({
              status,
              error: { code: "synthetic_failed", message: "Synthetic failure" },
            }),
      );
      const body = { image: "same-synthetic-photo" };
      for (let i = 0; i < 2; i++) {
        const run = settle(client.submitJob("/recognitions", body));
        if (status === "failed")
          await expect(run).rejects.toMatchObject({
            code: "synthetic_failed",
            jobId: "terminal-job",
          });
        else await run;
        expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
      }
      expect(new Set(postKeys()).size).toBe(2);
    },
  );

  it("discards a definitively invalid request instead of retaining its operation", async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        { code: "invalid_request", message: "Synthetic invalid request" },
        400,
      ),
    );
    const body = { medicationIds: ["a"] };
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
    await settle(client.submitJob("/bundles", body));
    expect(new Set(postKeys()).size).toBe(2);
  });

  it("keeps a bounded memory fallback when sessionStorage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw Error("Blocked storage");
      },
      setItem() {
        throw Error("Blocked storage");
      },
      removeItem() {
        throw Error("Blocked storage");
      },
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Lost response"));
    const body = { medicationIds: ["a"] };
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "network_error",
    });
    await settle(client.submitJob("/bundles", body));
    expect(new Set(postKeys()).size).toBe(1);
  });

  it("refuses pending overflow rather than silently evicting an ambiguous operation", async () => {
    fetchMock.mockRejectedValue(new TypeError("Lost response"));
    for (let i = 0; i < 32; i++)
      await expect(
        client.submitJob("/bundles", { medicationIds: ["synthetic-" + i] }),
      ).rejects.toMatchObject({ code: "network_error" });
    await expect(
      client.submitJob("/bundles", { medicationIds: ["synthetic-overflow"] }),
    ).rejects.toMatchObject({ code: "pending_limit" });
    expect(postKeys()).toHaveLength(32);
    await expect(
      client.submitJob("/bundles", { medicationIds: ["synthetic-0"] }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(postKeys().at(-1)).toBe(postKeys()[0]);
  });

  it("does not reuse another account's pending operation, including after logout", async () => {
    fetchMock.mockRejectedValue(new TypeError("Lost response"));
    const body = { medicationIds: ["a"] };
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "network_error",
    });
    client.setJobIdentity(null);
    expect(stored.has(PENDING_JOB_STORAGE_KEY)).toBe(false);
    client.setJobIdentity("synthetic-account-b");
    client.setTokenProvider(async () => "synthetic-token-b");
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "network_error",
    });
    expect(new Set(postKeys()).size).toBe(2);
  });

  it("a different account after reload cannot restore a stored owner's key or jobId", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Response lost"));
    const body = { medicationIds: ["a"] };
    await expect(client.submitJob("/bundles", body)).rejects.toMatchObject({
      code: "network_error",
    });
    vi.resetModules();
    client = await import("../src/api");
    client.setJobIdentity("synthetic-account-b");
    client.setTokenProvider(async () => "synthetic-token-b");
    await settle(client.submitJob("/bundles", body));
    expect(new Set(postKeys()).size).toBe(2);
  });

  it("stops an old account's polling before it can use a new account token", async () => {
    const rememberedJob = deferred<void>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
        if (
          key === PENDING_JOB_STORAGE_KEY &&
          JSON.parse(value).some(
            (row: { jobId?: string }) => row.jobId === "synthetic-job",
          )
        )
          rememberedJob.resolve();
      },
      removeItem: (key: string) => stored.delete(key),
    });
    const oldRun = client.submitJob("/bundles", { medicationIds: ["a"] });
    // Observe rejection immediately, including when a preceding assertion fails.
    void oldRun.catch(() => {});
    try {
      await rememberedJob.promise;
      expect(stored.get(PENDING_JOB_STORAGE_KEY)).toContain(
        '"jobId":"synthetic-job"',
      );
      client.setJobIdentity("synthetic-account-b");
      client.setTokenProvider(async () => "synthetic-token-b");
      await expect(settle(oldRun)).rejects.toMatchObject({
        code: "identity_changed",
        jobId: "synthetic-job",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await settle(client.submitJob("/bundles", { medicationIds: ["a"] }));
      expect(new Set(postKeys()).size).toBe(2);
      expect(
        new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get(
          "Authorization",
        ),
      ).toBe("Bearer synthetic-token-b");
    } finally {
      client.setJobIdentity(null);
      await settle(oldRun).catch(() => {});
    }
  });

  it("refuses to send an old input with a newly signed-in account's token", async () => {
    const token = deferred<string>();
    const requestedToken = deferred<void>();
    const provider = vi.fn(() => {
      requestedToken.resolve();
      return token.promise;
    });
    client.setTokenProvider(provider);
    const run = client.submitJob("/bundles", { medicationIds: ["private-a"] });
    void run.catch(() => {});
    try {
      await requestedToken.promise;
      expect(provider).toHaveBeenCalled();
      client.setJobIdentity("synthetic-account-b");
      token.resolve("synthetic-token-b");
      await expect(run).rejects.toMatchObject({ code: "identity_changed" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      client.setJobIdentity(null);
      token.resolve("synthetic-token-b");
      await settle(run).catch(() => {});
    }
  });
});
