import { describe, expect, it } from "vitest";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";

async function fixture() {
  const store = new MemoryStore();
  const domain = new Domain(store);
  await domain.account({
    uid: "owner",
    email: "owner@example.test",
    name: "合成測試",
    admin: false,
    verified: true,
  });
  await domain.account({
    uid: "other",
    email: "other@example.test",
    name: "其他帳號",
    admin: false,
    verified: true,
  });
  await store.set("jobs", "recognized", {
    id: "recognized",
    ownerId: "owner",
    kind: "recognition",
    status: "succeeded",
    result: { medications: [{ name: "合成甲" }, { name: "合成乙" }] },
  });
  return { store, domain };
}
const input = {
  name: "已核對的合成藥品",
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
  confirmed: true,
};

describe("resuming saved recognition results", () => {
  it("saves each recognized row once when responses are lost or tabs race", async () => {
    const { store, domain } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        domain.saveRecognizedMedication("owner", "recognized", 0, input),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await store.list("medications")).toHaveLength(1);
    expect((await store.get("jobs", "recognized"))?.savedMedications).toEqual({
      "0": { id: results[0].id, name: input.name },
    });
    const resumedDomain = new Domain(store);
    await expect(
      resumedDomain.saveRecognizedMedication("owner", "recognized", 0, {
        ...input,
        doseAmount: 6,
      }),
    ).rejects.toMatchObject({ code: "recognition_saved_conflict" });
    expect((await store.get("medications", results[0].id))?.doseAmount).toBe(1);
    expect((await store.get("medications", results[0].id))?.revision).toBe(1);
    await resumedDomain.saveRecognizedMedication(
      "owner",
      "recognized",
      1,
      input,
    );
    expect(await store.list("medications")).toHaveLength(2);
  });
  it("does not restore an archived medication when resuming an old recognition", async () => {
    const { domain } = await fixture();
    const med = await domain.saveRecognizedMedication(
      "owner",
      "recognized",
      0,
      input,
    );
    await domain.removeMedication("owner", med.id);
    await expect(
      domain.saveRecognizedMedication("owner", "recognized", 0, input),
    ).rejects.toMatchObject({ code: "already_saved" });
    expect(await domain.medications("owner")).toHaveLength(0);
  });
  it("rejects another owner's job, invalid rows and unfinished jobs without saving", async () => {
    const { store, domain } = await fixture();
    await expect(
      domain.saveRecognizedMedication("other", "recognized", 0, input),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const index of [-1, 0.5, 2])
      await expect(
        domain.saveRecognizedMedication("owner", "recognized", index, input),
      ).rejects.toMatchObject({ code: "invalid_recognition" });
    const job = await store.get("jobs", "recognized");
    await store.set("jobs", "recognized", { ...job, status: "running" });
    await expect(
      domain.saveRecognizedMedication("owner", "recognized", 0, input),
    ).rejects.toMatchObject({ code: "invalid_recognition" });
    expect(await store.list("medications")).toHaveLength(0);
  });
});
