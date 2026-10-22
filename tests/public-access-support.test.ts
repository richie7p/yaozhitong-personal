import { afterEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { config, fail } from "../server/config";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { Support } from "../server/support";
import type { Identity } from "../shared/schema";
const before = {
  mode: config.mode,
  publicAccess: config.publicAccess,
  userLimit: config.userLimit,
  globalLimit: config.globalLimit,
};
afterEach(() => {
  Object.assign(config, before);
  vi.useRealTimers();
});
async function setup() {
  Object.assign(config, {
    mode: "firebase",
    publicAccess: "verified",
    userLimit: 20,
    globalLimit: 1000,
  });
  const store = new MemoryStore(),
    d = new Domain(store, undefined, () => ({ json: async () => ({}) }));
  const ids: Record<string, Identity> = Object.fromEntries(
    ["owner", "other", "unverified", "admin"].map((uid) => [
      uid,
      {
        uid,
        email: uid + "@example.test",
        name: uid,
        verified: uid !== "unverified",
        admin: uid === "admin",
      },
    ]),
  );
  for (const id of Object.values(ids)) await d.account(id);
  const app = createApp(
    d,
    async (token) => ids[token] || fail("unauthenticated", "請先登入。", 401),
  );
  const request = (
    path: string,
    who = "owner",
    method = "GET",
    body?: unknown,
    key = "support-operation-001",
  ) =>
    app.request("/api/v1" + path, {
      method,
      headers: {
        Authorization: "Bearer " + who,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { store, d, request, support: new Support(store) };
}
const message = {
  category: "bug",
  message: "Synthetic report: the button was unavailable.",
};
describe("verified public access and unchanged per-person limit", () => {
  it("admits a verified ordinary account without approval or a tester seat", async () => {
    const { d, store, request } = await setup();
    expect((await store.get("users", "owner"))?.eligible).toBe(false);
    await expect(
      d.enqueueJob(
        "owner",
        true,
        "recognition",
        { imageHash: "synthetic" },
        "public-operation-01",
      ),
    ).resolves.toMatchObject({ status: "queued" });
    expect(await store.get("settings", "testerSeats")).toBeNull();
    const cfg = await (await request("/config")).json();
    expect(cfg).toMatchObject({
      publicAccess: "verified",
      dailyUserLimit: 20,
      dailyGlobalLimit: 1000,
    });
  });
  it("still rejects unverified, disabled and deleting accounts", async () => {
    const { d, store } = await setup();
    await expect(
      d.enqueueJob(
        "unverified",
        false,
        "recognition",
        {},
        "public-operation-02",
      ),
    ).rejects.toMatchObject({ code: "email_unverified" });
    await store.set("users", "owner", {
      ...(await store.get("users", "owner")),
      disabled: true,
    });
    await expect(
      d.enqueueJob("owner", true, "recognition", {}, "public-operation-03"),
    ).rejects.toMatchObject({ code: "account_disabled" });
    await store.set("users", "owner", {
      ...(await store.get("users", "owner")),
      disabled: false,
      deleting: true,
    });
    await expect(
      d.enqueueJob("owner", true, "recognition", {}, "public-operation-04"),
    ).rejects.toMatchObject({ code: "account_disabled" });
  });
  it("enforces 20 per person atomically under concurrent requests", async () => {
    const { d, store } = await setup();
    const result = await Promise.allSettled(
      Array.from({ length: 23 }, (_, i) =>
        d.enqueueJob(
          "owner",
          true,
          "recognition",
          {},
          "public-concurrent-" + i,
        ),
      ),
    );
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(20);
    expect(
      result
        .filter((x) => x.status === "rejected")
        .every(
          (x) => x.status === "rejected" && x.reason.code === "quota_exceeded",
        ),
    ).toBe(true);
    expect(await store.list("jobs")).toHaveLength(20);
  });
  it("enforces 1000 site-wide without charging a rejected user", async () => {
    const { d, store } = await setup();
    const day = DateTime.now().setZone("Asia/Taipei").toISODate();
    await store.set("usage", "global-" + day, { count: 999 });
    const result = await Promise.allSettled([
      d.enqueueJob("owner", true, "recognition", {}, "public-capacity-01"),
      d.enqueueJob("other", true, "recognition", {}, "public-capacity-02"),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await store.get("usage", "global-" + day))?.count).toBe(1000);
    expect(await store.list("jobs")).toHaveLength(1);
    expect(
      (await store.list("usage")).filter((row) => row.ownerId),
    ).toHaveLength(1);
  });
  it("retains approval-mode gate for deliberately restricted deployments", async () => {
    const { d } = await setup();
    config.publicAccess = "approved";
    await expect(
      d.enqueueJob("owner", true, "recognition", {}, "public-operation-05"),
    ).rejects.toMatchObject({ code: "not_eligible" });
  });
});
describe("private support", () => {
  it("resets the daily report allowance at Taiwan midnight and retains the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T15:59:00.000Z"));
    const { support, store } = await setup();
    await store.set("supportLimits", "owner", {
      id: "owner",
      ownerId: "owner",
      day: "2026-10-22",
      count: 5,
      lastAt: Date.now() - 120000,
    });
    await expect(
      support.create("owner", "support-before-midnight", message),
    ).rejects.toMatchObject({ code: "support_rate_limit" });
    vi.setSystemTime(new Date("2026-10-22T16:00:00.000Z"));
    await expect(
      support.create("owner", "support-after-midnight", message),
    ).resolves.toMatchObject({ ownerId: "owner" });
    expect(await store.get("supportLimits", "owner")).toMatchObject({
      day: "2026-10-23",
      count: 1,
    });
    await expect(
      support.create("owner", "support-too-soon-midnight", message),
    ).rejects.toMatchObject({ code: "support_rate_limit" });
  });
  it("requires login, verification and administrator rights at HTTP boundaries", async () => {
    const { request } = await setup();
    expect((await request("/support", "unknown")).status).toBe(401);
    expect(
      (await request("/support", "unverified", "POST", message)).status,
    ).toBe(403);
    expect((await request("/admin/support")).status).toBe(403);
    expect(
      (
        await request("/support", "owner", "POST", {
          category: "bug",
          message: "甲".repeat(5000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request("/admin/support/missing", "other", "PATCH", {
          message: "no",
          status: "resolved",
        })
      ).status,
    ).toBe(403);
  });
  it("isolates owners, handles lost-response retries, rate limits spam and allows private replies", async () => {
    const { request } = await setup();
    const result = await request("/support", "owner", "POST", message);
    expect(result.status).toBe(201);
    const row = await result.json();
    const repeated = await (
      await request("/support", "owner", "POST", message)
    ).json();
    expect(repeated.id).toBe(row.id);
    expect(
      (
        await request("/support", "owner", "POST", {
          ...message,
          message: "different synthetic message",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          "/support",
          "owner",
          "POST",
          message,
          "support-operation-002",
        )
      ).status,
    ).toBe(429);
    expect((await (await request("/support", "other")).json()).items).toEqual(
      [],
    );
    expect(
      (
        await request("/admin/support/" + row.id, "admin", "PATCH", {
          message: "Synthetic fix confirmed.",
          status: "resolved",
        })
      ).status,
    ).toBe(200);
    expect((await (await request("/support")).json()).items[0]).toMatchObject({
      status: "resolved",
      replies: [{ message: "Synthetic fix confirmed." }],
    });
    expect(
      (await (await request("/admin/support", "admin")).json()).items,
    ).toHaveLength(1);
  });
  it("exports and deletes support content together with account data", async () => {
    const { d, support, store } = await setup();
    const row = await support.create("owner", "support-operation-01", message);
    expect((await d.exportUser("owner")).supportTickets[0].id).toBe(row.id);
    // Local cleanup boundary avoids any live Authentication request.
    config.mode = "local";
    await d.cleanupUser("owner");
    expect(await store.get("supportTickets", row.id)).toBeNull();
    expect(await store.get("supportLimits", "owner")).toBeNull();
  });
  it("paginates tied timestamps without duplicating or exposing another owner's reports", async () => {
    const { store, support } = await setup();
    for (let i = 0; i < 55; i++)
      await store.set("supportTickets", i.toString(16).padStart(64, "0"), {
        id: i.toString(16).padStart(64, "0"),
        ownerId: "owner",
        createdAt: "2026-10-22T00:00:00.000Z",
        message: "synthetic",
        replies: [],
      });
    await store.set("supportTickets", "another-owner", {
      id: "another-owner",
      ownerId: "other",
      createdAt: "2026-10-23T00:00:00.000Z",
    });
    const first = await support.page("", "owner"),
      next = await support.page(first.nextCursor, "owner");
    expect(first.items).toHaveLength(50);
    expect(next.items).toHaveLength(5);
    expect(
      new Set([...first.items, ...next.items].map((row) => row.id)).size,
    ).toBe(55);
    expect(next.nextCursor).toBe("");
    await expect(support.page("invalid", "owner")).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });
  it("does not attach health data or disclose a private contact address", async () => {
    const { support, store } = await setup();
    await store.set("profiles", "owner", {
      ownerId: "owner",
      secret: "private-health-fixture",
    });
    const row = await support.create("owner", "support-operation-01", message);
    expect(JSON.stringify(row)).not.toContain("private-health-fixture");
    expect(JSON.stringify(row)).not.toContain("@example.test");
    await expect(
      support.create("other", "support-operation-02", {
        ...message,
        image: "forbidden attachment",
      }),
    ).rejects.toThrow();
  });
});

it("deduplicates a lost administrator reply response and rejects changed content under its old key", async () => {
  const { request } = await setup();
  const row = await (
    await request("/support", "owner", "POST", message)
  ).json();
  const reply = { message: "Synthetic response is ready.", status: "resolved" };
  const path = "/admin/support/" + row.id;
  expect(
    (await request(path, "admin", "PATCH", reply, "admin-reply-operation-01"))
      .status,
  ).toBe(200);
  expect(
    (await request(path, "admin", "PATCH", reply, "admin-reply-operation-01"))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        path,
        "admin",
        "PATCH",
        { ...reply, message: "Different reply content." },
        "admin-reply-operation-01",
      )
    ).status,
  ).toBe(409);
  const mine = await (await request("/support")).json();
  expect(mine.items[0].replies).toHaveLength(1);
});
