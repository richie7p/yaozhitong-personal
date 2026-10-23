import { afterEach, describe, expect, it, vi } from "vitest";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { config } from "../server/config";
const identity = {
  uid: "concurrent-owner",
  email: "owner@example.test",
  name: "Synthetic owner",
  verified: true,
  admin: false,
};
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const store = new MemoryStore();
  const domain = new Domain(store, undefined, () => ({
    json: async () => ({}),
  }));
  await domain.account(identity);
  return { store, domain };
}
describe("concurrent account reads and exact AI reservations", () => {
  it("reads existing accounts without a write transaction, but still enforces changed claims and disabled state", async () => {
    const { store, domain } = await fixture();
    const tx = vi.spyOn(store, "transaction");
    await Promise.all(
      Array.from({ length: 100 }, () => domain.account(identity)),
    );
    expect(tx).not.toHaveBeenCalled();
    expect((await domain.account({ ...identity, admin: true })).admin).toBe(
      true,
    );
    expect(tx).toHaveBeenCalledOnce();
    store.data.users[identity.uid].disabled = true;
    await expect(
      domain.account({ ...identity, admin: true }),
    ).rejects.toMatchObject({ code: "account_disabled", status: 403 });
  });
  it("creates a single account during simultaneous first login", async () => {
    const store = new MemoryStore(),
      domain = new Domain(store);
    await Promise.all(
      Array.from({ length: 30 }, () => domain.account(identity)),
    );
    expect(await store.list("users")).toHaveLength(1);
  });
  it("coalesces 100 identical reservations but rejects conflicting payload and an unverified caller", async () => {
    const { store, domain } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    domain.enqueue = vi.fn(async () => {
      await gate;
    });
    const calls = Array.from({ length: 100 }, () =>
      domain.enqueueJob(
        identity.uid,
        true,
        "recognition",
        { imageHash: "A", mediaType: "image/png" },
        "one-operation-001",
      ),
    );
    await vi.waitFor(() => expect(domain.enqueue).toHaveBeenCalledOnce());
    await expect(
      domain.enqueueJob(
        identity.uid,
        true,
        "recognition",
        { imageHash: "B", mediaType: "image/png" },
        "one-operation-001",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(
      domain.enqueueJob(
        identity.uid,
        false,
        "recognition",
        { imageHash: "A", mediaType: "image/png" },
        "one-operation-001",
      ),
    ).rejects.toMatchObject({ code: "email_unverified", status: 403 });
    release();
    const jobs = await Promise.all(calls);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
    expect((await store.list("usage")).map((r) => r.count)).toEqual([1, 1]);
    expect(await store.list("jobs")).toHaveLength(1);
  });
  it.each([4, 8, 10, 14])(
    "returns recoverable 503 for explicit transient datastore failure %s without revealing SDK details",
    async (code) => {
      const { domain } = await fixture();
      vi.spyOn(domain, "me").mockRejectedValue(
        Object.assign(
          new Error("private token and medical input must stay hidden"),
          { code },
        ),
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      const app = createApp(domain, async () => identity);
      const response = await app.request("/api/v1/me");
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("3");
      const body = await response.json();
      expect(body.code).toBe("service_busy");
      expect(JSON.stringify(body)).not.toContain("private token");
    },
  );
  it("does not disguise an unrelated programming error as overload", async () => {
    const { domain } = await fixture();
    vi.spyOn(domain, "me").mockRejectedValue(new TypeError("synthetic bug"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await createApp(domain, async () => identity).request(
      "/api/v1/me",
    );
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("internal_error");
  });
});
