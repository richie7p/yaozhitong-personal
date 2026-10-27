import { describe, expect, it } from "vitest";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import type { Identity } from "../shared/schema";

const input = {
  name: "手動建檔合成藥品",
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
  confirmed: true,
};
const identity: Identity = {
  uid: "owner",
  email: "owner@example.invalid",
  name: "合成測試",
  admin: false,
  verified: true,
};
async function fixture() {
  const store = new MemoryStore();
  const domain = new Domain(store);
  await domain.account(identity);
  await domain.account({ ...identity, uid: "other" });
  return { store, domain };
}

describe("manual and search creation response recovery", () => {
  it("concurrent and restarted same-input retries return one unchanged row without invalidating later learning or reminders", async () => {
    const { store, domain } = await fixture();
    const key = "synthetic-create-operation";
    const saved = await Promise.all(
      Array.from({ length: 5 }, () =>
        domain.saveMedication("owner", input, undefined, key),
      ),
    );
    expect(new Set(saved.map((m) => m.id)).size).toBe(1);
    expect(saved.every((m) => m.revision === 1)).toBe(true);
    const id = saved[0].id;
    await store.set("learning", "later-learning", {
      ownerId: "owner",
      medicationIds: [id],
    });
    await store.set("schedules", "later-schedule", {
      id: "later-schedule",
      ownerId: "owner",
      medicationId: id,
      active: true,
    });
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(
      (
        await new Domain(store).saveMedication(
          "owner",
          reordered,
          undefined,
          key,
        )
      ).id,
    ).toBe(id);
    expect(await store.list("medications")).toHaveLength(1);
    expect(await store.get("learning", "later-learning")).not.toBeNull();
    expect((await store.get("schedules", "later-schedule"))?.active).toBe(true);
  });

  it("rejects changed input for the same operation and keeps the first payload", async () => {
    const { store, domain } = await fixture();
    const saved = await domain.saveMedication(
      "owner",
      input,
      undefined,
      "same-operation-001",
    );
    await expect(
      domain.saveMedication(
        "owner",
        { ...input, doseAmount: 6 },
        undefined,
        "same-operation-001",
      ),
    ).rejects.toMatchObject({ code: "medication_saved_conflict", status: 409 });
    expect((await store.get("medications", saved.id))?.doseAmount).toBe(1);
    expect((await store.get("medications", saved.id))?.revision).toBe(1);
  });

  it("does not overwrite an edited row or revive an archived row", async () => {
    const { store, domain } = await fixture();
    const saved = await domain.saveMedication(
      "owner",
      input,
      undefined,
      "same-operation-002",
    );
    await domain.saveMedication("owner", { ...input, doseAmount: 6 }, saved.id);
    await expect(
      domain.saveMedication("owner", input, undefined, "same-operation-002"),
    ).rejects.toMatchObject({ code: "medication_saved_conflict" });
    expect((await store.get("medications", saved.id))?.doseAmount).toBe(6);
    await domain.removeMedication("owner", saved.id);
    await expect(
      domain.saveMedication("owner", input, undefined, "same-operation-002"),
    ).rejects.toMatchObject({ code: "already_saved" });
    expect(await domain.medications("owner")).toHaveLength(0);
    expect(await store.list("medications")).toHaveLength(1);
  });

  it("scopes operations to their owner and allows a deliberate new operation for an identical medication", async () => {
    const { store, domain } = await fixture();
    const a = await domain.saveMedication(
      "owner",
      input,
      undefined,
      "same-operation-003",
    );
    const b = await domain.saveMedication(
      "other",
      input,
      undefined,
      "same-operation-003",
    );
    const next = await domain.saveMedication(
      "owner",
      input,
      undefined,
      "next-operation-003",
    );
    expect(new Set([a.id, b.id, next.id]).size).toBe(3);
    expect(await domain.medications("owner")).toHaveLength(2);
    expect(await domain.medications("other")).toHaveLength(1);
    expect(await store.list("jobs")).toHaveLength(0);
    expect(await store.list("usage")).toHaveLength(0);
  });

  it("rechecks account state before returning an existing creation receipt", async () => {
    const { store, domain } = await fixture();
    await domain.saveMedication(
      "owner",
      input,
      undefined,
      "same-operation-004",
    );
    const user = await store.get("users", "owner");
    for (const state of [{ disabled: true }, { deleting: true }]) {
      await store.set("users", "owner", { ...user, ...state });
      await expect(
        domain.saveMedication("owner", input, undefined, "same-operation-004"),
      ).rejects.toMatchObject({ code: "account_disabled" });
    }
    expect(await store.list("medications")).toHaveLength(1);
  });

  it("uses the public endpoint header and rejects malformed keys without saving", async () => {
    const { store, domain } = await fixture();
    const app = createApp(domain, async () => identity);
    const request = (key: string, body = input) =>
      app.request("/api/v1/medications", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
    const first = await request("http-operation-001");
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const retry = await request("http-operation-001");
    expect(retry.status).toBe(201);
    expect((await retry.json()).id).toBe(firstBody.id);
    expect(
      (await request("http-operation-001", { ...input, doseAmount: 7 })).status,
    ).toBe(409);
    expect((await request("bad/key")).status).toBe(400);
    expect(await store.list("medications")).toHaveLength(1);
  });
});
