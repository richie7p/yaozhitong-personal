import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { readAiUsage } from "../server/ai-usage";
import { MemoryStore } from "../server/store";
import { Domain, hash } from "../server/domain";
import { createApp } from "../server/app";
import { config } from "../server/config";

const at = DateTime.fromISO("2026-11-05T15:59:00Z");
const limits = { userLimit: 30, globalLimit: 2000 };
let original: typeof config;
beforeEach(() => {
  original = { ...config };
  Object.assign(config, {
    ...limits,
    mode: "local",
    role: "web",
    publicAccess: "verified",
    aiProvider: "openai",
    openaiKey: "synthetic-only",
  });
});
afterEach(() => {
  Object.assign(config, original);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("remaining AI uses from admission counters", () => {
  it("is read-only and takes the smaller personal or shared remainder", async () => {
    const store = new MemoryStore();
    await store.set("usage", hash("reader|2026-11-05"), { count: 3 });
    await store.set("usage", "global-2026-11-05", { count: 1998 });
    await store.set("usage", hash("someone-else|2026-11-05"), { count: 30 });
    const before = structuredClone(store.data);
    const usage = await readAiUsage(store, "reader", limits, "ready", at);
    expect(usage.personal).toEqual({ used: 3, limit: 30, remaining: 27 });
    expect(usage.global.remaining).toBe(2);
    expect(usage.available).toBe(2);
    expect(usage.resetsAt).toBe("2026-11-06T00:00:00.000+08:00");
    expect(store.data).toEqual(before);
    expect(await readAiUsage(store, "reader", limits, "ready", at)).toEqual(
      usage,
    );
  });

  it("starts a fresh Taiwan day while UTC is still on the previous date", async () => {
    const store = new MemoryStore();
    await store.set("usage", hash("reader|2026-11-05"), { count: 30 });
    await store.set("usage", "global-2026-11-05", { count: 2000 });
    const usage = await readAiUsage(
      store,
      "reader",
      limits,
      "ready",
      at.plus({ minutes: 1 }),
    );
    expect(usage.date).toBe("2026-11-06");
    expect(usage.available).toBe(30);
    expect(usage.resetsAt).toBe("2026-11-07T00:00:00.000+08:00");
  });

  it("does not show negative remaining counts after a lower limit is configured", async () => {
    const store = new MemoryStore();
    await store.set("usage", hash("reader|2026-11-05"), { count: 35 });
    const usage = await readAiUsage(store, "reader", limits, "ready", at);
    expect(usage.personal.remaining).toBe(0);
    expect(usage.personal.used).toBe(35);
    expect(usage.available).toBe(0);
  });

  it("reads only the authenticated account and reflects a deduplicated accepted job once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at.toJSDate());
    const store = new MemoryStore();
    const d = new Domain(store);
    const identity = {
      uid: "reader",
      email: "reader@example.invalid",
      name: "Synthetic reader",
      verified: true,
      admin: false,
    };
    await d.account(identity);
    const app = createApp(d, async () => identity);
    const endpoint = "/api/v1/ai/usage?uid=someone-else";
    expect(
      (await (await app.request(endpoint)).json()).personal.remaining,
    ).toBe(30);
    await d.enqueueJob(
      "reader",
      true,
      "recognition",
      { imageHash: "synthetic-photo", mediaType: "image/png" },
      "synthetic-key",
    );
    await d.enqueueJob(
      "reader",
      true,
      "recognition",
      { imageHash: "synthetic-photo", mediaType: "image/png" },
      "synthetic-key",
    );
    const before = structuredClone(store.data);
    const response = await app.request(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      personal: { used: 1, remaining: 29 },
      global: { used: 1, remaining: 1999 },
      access: "ready",
    });
    expect(store.data).toEqual(before);
  });

  it("shows verification requirements without spending quota", async () => {
    const store = new MemoryStore();
    const d = new Domain(store);
    const app = createApp(d, async () => ({
      uid: "unverified",
      email: "unverified@example.invalid",
      name: "Synthetic",
      verified: false,
      admin: false,
    }));
    const response = await app.request("/api/v1/ai/usage");
    expect(await response.json()).toMatchObject({
      access: "email_unverified",
      available: 30,
    });
    expect(await store.list("usage")).toEqual([]);
  });

  it("raises available quota while preserving the day's existing use counters", async () => {
    const store = new MemoryStore();
    await store.set("usage", hash("reader|2026-11-05"), { count: 20 });
    await store.set("usage", "global-2026-11-05", { count: 1000 });
    const before = structuredClone(store.data);
    const usage = await readAiUsage(store, "reader", limits, "ready", at);
    expect(usage.personal).toEqual({ used: 20, limit: 30, remaining: 10 });
    expect(usage.global).toEqual({ used: 1000, limit: 2000, remaining: 1000 });
    expect(usage.available).toBe(10);
    expect(store.data).toEqual(before);
  });
});
