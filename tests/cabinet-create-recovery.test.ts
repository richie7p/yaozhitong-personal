import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Identity } from "../shared/schema";

const input = { name: "合成藥箱項目", quantity: 12, unit: "錠" };
const identity: Identity = {
  uid: "owner",
  email: "owner@example.invalid",
  name: "合成測試",
  admin: false,
  verified: true,
};
async function fixture() {
  const store = new MemoryStore(),
    domain = new Domain(store);
  await domain.account(identity);
  await domain.account({ ...identity, uid: "other" });
  return { store, domain };
}

describe("cabinet create response recovery", () => {
  it("deduplicates concurrent and restarted same-input requests without rewriting the row", async () => {
    const { store, domain } = await fixture();
    const rows = await Promise.all(
      Array.from({ length: 5 }, () =>
        domain.saveCabinet("owner", input, undefined, "cabinet-operation-001"),
      ),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const saved = rows[0];
    const retry = await new Domain(store).saveCabinet(
      "owner",
      Object.fromEntries(Object.entries(input).reverse()),
      undefined,
      "cabinet-operation-001",
    );
    expect(retry).toEqual(saved);
    expect(await store.list("cabinet")).toHaveLength(1);
  });

  it("rejects a different payload under the same create key and keeps the original stock", async () => {
    const { store, domain } = await fixture();
    const saved = await domain.saveCabinet(
      "owner",
      input,
      undefined,
      "cabinet-operation-002",
    );
    await expect(
      domain.saveCabinet(
        "owner",
        { ...input, quantity: 20 },
        undefined,
        "cabinet-operation-002",
      ),
    ).rejects.toMatchObject({ code: "cabinet_saved_conflict", status: 409 });
    expect((await store.get("cabinet", saved.id))?.quantity).toBe(12);
  });

  it("does not replace a later edit or revive a disposed item when an old create response is retried", async () => {
    const { store, domain } = await fixture();
    const saved = await domain.saveCabinet(
      "owner",
      input,
      undefined,
      "cabinet-operation-003",
    );
    await domain.saveCabinet(
      "owner",
      { ...input, quantity: 3, disposed: true },
      saved.id,
    );
    await expect(
      domain.saveCabinet("owner", input, undefined, "cabinet-operation-003"),
    ).rejects.toMatchObject({ code: "cabinet_saved_conflict", status: 409 });
    expect(await store.get("cabinet", saved.id)).toMatchObject({
      quantity: 3,
      disposed: true,
      revision: 2,
    });
    expect(await store.list("cabinet")).toHaveLength(1);
  });

  it("separates owners and deliberate new operations while retaining legacy callers", async () => {
    const { store, domain } = await fixture();
    const rows = await Promise.all([
      domain.saveCabinet("owner", input, undefined, "cabinet-operation-004"),
      domain.saveCabinet("other", input, undefined, "cabinet-operation-004"),
      domain.saveCabinet("owner", input, undefined, "cabinet-operation-005"),
      domain.saveCabinet("owner", input),
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    await expect(
      domain.saveCabinet("other", input, rows[0].id),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await store.list("jobs")).toHaveLength(0);
    expect(await store.list("usage")).toHaveLength(0);
  });

  it("rechecks deletion or disabled state before returning an existing receipt", async () => {
    const { store, domain } = await fixture();
    await domain.saveCabinet(
      "owner",
      input,
      undefined,
      "cabinet-operation-006",
    );
    const owner = await store.get("users", "owner");
    for (const state of [{ disabled: true }, { deleting: true }]) {
      await store.set("users", "owner", { ...owner, ...state });
      await expect(
        domain.saveCabinet("owner", input, undefined, "cabinet-operation-006"),
      ).rejects.toMatchObject({ code: "account_disabled" });
    }
    expect(await store.list("cabinet")).toHaveLength(1);
  });

  it("forwards a valid HTTP idempotency key and rejects an invalid key", async () => {
    const { store, domain } = await fixture();
    const app = createApp(domain, async () => identity);
    const post = (key: string) =>
      app.request("/api/v1/cabinet", {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(input),
      });
    const first = await post("cabinet-operation-007"),
      retry = await post("cabinet-operation-007");
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect((await first.json()).id).toBe((await retry.json()).id);
    expect((await post("bad")).status).toBe(400);
    expect(await store.list("cabinet")).toHaveLength(1);
  });
});
