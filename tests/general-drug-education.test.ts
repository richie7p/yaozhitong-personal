import { describe, expect, it, vi } from "vitest";
import { recognize } from "../server/ai";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Drug, Job } from "../shared/schema";

const absentDirections = {
  doseAmount: null, doseUnit: null, doseText: null, frequencyRaw: null,
  route: null, durationDays: null,
};

describe("medicine labels without a personal prescription", () => {
  it.each([
    ["合成乳膏", "1%", "乳膏", "合成乳膏 1% 15g/管"],
    ["合成錠", "5mg", "錠", "合成錠 5mg 外盒"],
    ["合成藥水", "2mg/ml", "口服液", "合成藥水 2mg/ml 60ml/瓶"],
    ["合成膠囊", "10mg", "膠囊", "合成膠囊 10mg 鋁箔藥板"],
  ])("keeps a clear %s label usable without inventing directions", async (name, strength, form, rawText) => {
    const output = await recognize({ json: async () => ({
      status: "succeeded", medications: [{ name, strength, form, rawText,
        confidence: "high", ...absentDirections }],
    }) }, Buffer.from("synthetic image; mocked vision output"), "image/png");
    expect(output.status).toBe("succeeded");
    expect(output.medications[0]).toMatchObject({
      name, strength, form, rawText, confidence: "high", ...absentDirections,
    });
    expect(output.guidance).toContain("查看用途與衛教");
    expect(output.guidance).toContain("設定個人提醒前");
  });

  it("keeps unsupported strengths and conflicting directions low-confidence", async () => {
    const output = await recognize({ json: async () => ({
      status: "succeeded", medications: [{ name: "合成乳膏", strength: "5mg", form: "乳膏",
        rawText: "合成乳膏 1%；外用；口服", confidence: "high", ...absentDirections }],
    }) }, Buffer.from("synthetic image"), "image/png");
    expect(output.medications[0]).toMatchObject({ strength: null, confidence: "low", ...absentDirections });
    expect(output.guidance).toContain("矛盾");
  });

  it("preserves a failed unreadable label response without filling a guessed drug", async () => {
    const output = await recognize({ json: async () => ({
      status: "failed", medications: [], guidance: "無法讀取藥名，請補拍原包裝。",
    }) }, Buffer.from("synthetic unlabelled image"), "image/png");
    expect(output).toEqual({ status: "failed", medications: [], guidance: "無法讀取藥名，請補拍原包裝。" });
  });
});

it("does not send an unconfirmed package dose or draft instructions as personal usage to chat", async () => {
  const store = new MemoryStore();
  const calls: unknown[] = [];
  const json = vi.fn(async (_prompt: string, input: unknown) => {
    calls.push(input);
    return { status: "not_found", claims: [], quiz: [], followups: [] };
  });
  const domain = new Domain(store, undefined, () => ({ json }));
  const drug: Drug = { licenseNo: "SYNTHETIC-EDUCATION", nameZh: "合成乳膏", nameEn: "Synthetic cream", strength: "1%", form: "乳膏", ingredients: [], revoked: false };
  domain.catalog.all = async () => [drug];
  domain.catalog.get = async () => drug;
  const uid = "synthetic-education-owner";
  await domain.account({ uid, name: "合成測試", email: "education@example.invalid", verified: true, admin: false });
  const med = await domain.saveMedication(uid, {
    name: drug.nameZh, identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    confirmed: false, doseAmount: 99, doseUnit: "公克", frequencyRaw: "未核對包裝頻次", instructions: "未核對的備註",
  });
  await store.set("leaflets", "education-source", {
    id: "education-source", licenseNo: drug.licenseNo, version: "synthetic-v1", sha256: "synthetic", status: "published",
    chunks: [{ id: "education-chunk", licenseNo: drug.licenseNo, version: "synthetic-v1", page: 1, start: 0, text: "適應症：本文件僅用於合成軟體核對測試。" }],
  });
  await store.set("published", hash(drug.licenseNo), { leafletId: "education-source" });
  const job = await domain.enqueueJob(uid, true, "chat", { medicationIds: [med.id], question: "用途是什麼？" }, "education-context-operation");
  await domain.processJob(job.id);
  expect((await store.get<Job>("jobs", job.id))?.status).toBe("succeeded");
  expect(calls.length).toBeGreaterThan(0);
  const generation = calls.find((input: any) => input.kind === "chat") as any;
  expect(generation.context.medications[0]).toMatchObject({ name: drug.nameZh, usageConfirmed: false, usage: "" });
  expect(JSON.stringify(calls)).not.toMatch(/99|未核對包裝頻次|未核對的備註/);
});
