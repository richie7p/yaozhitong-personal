import { expect, it, vi } from "vitest";
import { assisted } from "../server/assistance";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Drug, Job, Medication } from "../shared/schema";

const drug: Drug = {
  licenseNo: "SYNTHETIC-GENERAL-CREAM",
  nameZh: "合成衛教乳膏",
  nameEn: "Synthetic cream",
  strength: "1%",
  form: "乳膏",
  ingredients: ["SYNTHETIC"],
  revoked: false,
};
const draft = {
  id: "draft-cream",
  ownerId: "education-owner",
  name: drug.nameZh,
  licenseNo: drug.licenseNo,
  doseAmount: 99,
  doseUnit: "公克",
  frequencyRaw: "未核對包裝頻次",
  instructions: "未核對的備註",
  revision: 1,
  confirmed: false,
} as Medication;
const source = {
  id: "reference-cream",
  title: "合成來源",
  url: "https://www.ntuh.gov.tw/synthetic-cream",
  kind: "hospital" as const,
};
const passage = "SYNTHETIC 乳膏的一般衛教合成測試資料。";
const search = {
  state: "found" as const,
  sources: [source],
  passages: [{ text: passage, sourceIds: [source.id] }],
};
const claim = {
  text: "關於 SYNTHETIC 乳膏的一般合成衛教。",
  basis: "reference" as const,
  sourceIds: [source.id],
  evidenceQuotes: [{ sourceId: source.id, quote: passage }],
};

it("retrieves general education for a package while excluding unconfirmed personal directions", async () => {
  const json = vi.fn()
    .mockResolvedValueOnce({ status: "answered", claims: [claim] })
    .mockResolvedValueOnce({ decisions: [{ id: "0", supported: true }] });
  const searchReferences = vi.fn(async () => search);
  const result = await assisted({ json, searchReferences }, "一般用途？", [draft], [drug], [null]);

  expect(searchReferences).toHaveBeenCalledWith([drug]);
  expect(result.status).toBe("supported");
  expect(result.assistance?.claims).toEqual([
    { text: claim.text, basis: "reference", sourceIds: [source.id] },
  ]);
  for (const [, context] of json.mock.calls as unknown as [string, { userLabels: unknown[] }][]) {
    expect(context.userLabels).toEqual([]);
  }
  expect(JSON.stringify(json.mock.calls)).not.toMatch(/99|未核對包裝頻次|未核對的備註/);
  expect(result.assistance?.uncertainties.join("")).toContain("個人用法尚未確認");
});

it("does not turn unconfirmed package quantities into the no-source label fallback", async () => {
  const json = vi.fn();
  const result = await assisted({ json }, "一般用途？", [draft], [drug], [null]);
  expect(json).not.toHaveBeenCalled();
  expect(result.status).toBe("insufficient_data");
  expect(result.assistance?.claims).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/99|未核對包裝頻次|未核對的備註/);
});

it.each(["bundle", "chat"] as const)(
  "completes and saves missing-leaflet %s education without a personal usage confirmation",
  async (kind) => {
    const store = new MemoryStore();
    const json = vi.fn(async (_prompt: string, input: any) => input.expectedIds
      ? { decisions: [{ id: "0", supported: true }] }
      : { status: "answered", claims: [claim] });
    const domain = new Domain(store, undefined, () => ({ json, searchReferences: async () => search }));
    domain.catalog.all = async () => [drug];
    domain.catalog.get = async () => drug;
    domain.enqueue = async () => {};
    await domain.account({ uid: draft.ownerId, name: "合成測試", email: "education@example.invalid", verified: true, admin: false });
    const med = await domain.saveMedication(draft.ownerId, {
      ...draft,
      identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    });
    const job = await domain.enqueueJob(draft.ownerId, true, kind,
      { medicationIds: [med.id], ...(kind === "chat" ? { question: "一般用途？" } : {}) },
      "general-education-" + kind);
    await domain.processJob(job.id);
    expect((await store.get<Job>("jobs", job.id))?.status).toBe("succeeded");
    const record = await store.get(kind === "chat" ? "chats" : "learning", job.id);
    expect(record?.result.assistance.claims).toHaveLength(1);
    expect(await domain.learningCurrent(draft.ownerId, record!)).toBe(true);
    expect(JSON.stringify(json.mock.calls)).not.toMatch(/99|未核對包裝頻次|未核對的備註/);
  },
);
