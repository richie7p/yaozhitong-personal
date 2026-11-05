import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { createApp } from "../server/app";
import { config } from "../server/config";
import { Domain, hash } from "../server/domain";
import { explainDrug } from "../server/drug-explanation";
import { referenceSearchRequest, relevantReferenceText } from "../server/reference-search";
import { MemoryStore } from "../server/store";
import { Catalog, exactGeneralReferenceMatch } from "../server/catalog";
import type { Blobs } from "../server/blobs";
import { DrugExplanationRequestSchema, GENERAL_CATALOG_SOURCE, type DrugExplanationResult } from "../shared/drug-explanation";
import type { Drug, Job } from "../shared/schema";

const uid = "synthetic-general-owner";
const identity = { uid, name: "Synthetic owner", email: "general@example.invalid", verified: true, admin: false };
const query = { name: "合成清爽乳膏", strength: "1%", form: "乳膏" };
const source = { id: "source-general", title: "合成藥品衛教來源", url: "https://www.ntuh.gov.tw/synthetic-general-information", kind: "hospital" as const };
const passage = "合成清爽乳膏的合成測試文字，僅用來驗證軟體會核對逐字來源。";
const claim = { text: "同名乳膏的一般合成測試說明。", basis: "reference", sourceIds: [source.id], evidenceQuotes: [{ sourceId: source.id, quote: passage }] };
const search = { state: "found" as const, sources: [source], passages: [{ text: passage, sourceIds: [source.id] }] };
let original: typeof config;
beforeEach(() => {
  original = { ...config };
  Object.assign(config, { mode: "local", role: "web", publicAccess: "verified", aiProvider: "openai", openaiKey: "synthetic-only" });
});
afterEach(() => { Object.assign(config, original); vi.restoreAllMocks(); });

async function setup() {
  const store = new MemoryStore();
  const json = vi.fn(async (_prompt: string, input: any) => input.expectedIds
    ? { decisions: [{ id: "0", supported: true }] }
    : { status: "answered", claims: [claim] });
  const searchReferences = vi.fn(async (_products: Drug[]) => search);
  const domain = new Domain(store, undefined, () => ({ json, searchReferences }));
  domain.catalog.all = async () => [];
  domain.catalog.get = async () => null;
  await domain.account(identity);
  return { store, domain, json, searchReferences };
}
async function complete(domain: Domain, input: object, key = "general-explanation-test") {
  const job = await domain.enqueueJob(uid, true, "explanation", input, key);
  await domain.processJob(job.id);
  const stored = (await domain.store.get<Job>("jobs", job.id))!;
  expect(stored.status).toBe("succeeded");
  return stored;
}
function recognition(ownerId = uid, status: Job["status"] = "succeeded"): Job {
  return {
    id: "photo-query", ownerId, kind: "recognition", status, input: {},
    result: { status: "succeeded", medications: [{ ...query,
      doseAmount: 99, frequencyRaw: "SECRET-FREQUENCY", rawText: "PATIENT-PRIVATE-TEXT",
      candidates: [{ licenseNo: "CANDIDATE-ONLY", ingredients: ["UNCONFIRMED-INGREDIENT"] }],
    }] }, error: null, attempts: 1, leaseUntil: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

describe("general information without product or personal-usage confirmation", () => {
  it("explains a pending saved product without leaking candidate ingredients or prescription fields", async () => {
    const { domain, store, searchReferences, json } = await setup();
    const medication = await domain.saveMedication(uid, {
      ...query, confirmed: false, candidateLicenseNo: "CANDIDATE-ONLY",
      doseAmount: 99, doseUnit: "公克", frequencyRaw: "SECRET-FREQUENCY",
      rawText: "PATIENT-PRIVATE-TEXT", instructions: "PRIVATE-NOTE",
    });
    const before = structuredClone(await store.list("medications"));
    const job = await complete(domain, { medicationId: medication.id });
    const result = job.result as DrugExplanationResult;
    expect(result).toMatchObject({ mode: "general_information", queriedProduct: query, identityStatus: "unverified", status: "supported" });
    expect(result.assistance?.claims).toHaveLength(1);
    expect(result.assistance?.uncertainties[0]).toContain("產品尚未核對");
    expect(searchReferences.mock.calls[0][0]).toEqual([{ licenseNo: "", nameZh: query.name, nameEn: "", strength: query.strength, form: query.form, ingredients: [], revoked: false, identityVerified: false }]);
    expect(JSON.stringify([searchReferences.mock.calls, json.mock.calls])).not.toMatch(/99|SECRET-FREQUENCY|PATIENT-PRIVATE-TEXT|PRIVATE-NOTE|CANDIDATE-ONLY/);
    expect(await store.list("medications")).toEqual(before);
    expect(await store.list("learning")).toEqual([]);
    expect(await store.list("chats")).toEqual([]);
    await expect(domain.enqueueJob(uid, true, "bundle", { medicationIds: [medication.id] }, "still-checked-bundle")).rejects.toMatchObject({ code: "identity_unconfirmed" });
    const publicResult = await domain.publicJob(uid, job);
    expect(publicResult.result).toEqual(result);
    expect(publicResult).not.toHaveProperty("input");
    expect(publicResult).not.toHaveProperty("explanationFingerprint");
    expect(domain.jobSummary(job)).not.toHaveProperty("explanationFingerprint");
  });

  it("queries an owned photo row without creating any medication record and charges once", async () => {
    const { domain, store, searchReferences } = await setup();
    await store.set("jobs", "photo-query", recognition());
    const body = { recognitionId: "photo-query", medicationIndex: 0 };
    const first = await domain.enqueueJob(uid, true, "explanation", body, "photo-query-operation");
    const repeat = await domain.enqueueJob(uid, true, "explanation", body, "photo-query-operation");
    expect(repeat.id).toBe(first.id);
    await domain.processJob(first.id);
    const stored = (await store.get<Job>("jobs", first.id))!;
    expect(stored.status).toBe("succeeded");
    expect((await domain.publicJob(uid, stored)).result).toMatchObject({ queriedProduct: query, identityStatus: "unverified" });
    expect(JSON.stringify(searchReferences.mock.calls)).not.toMatch(/SECRET|PRIVATE|CANDIDATE|INGREDIENT/);
    expect(await store.list("medications")).toEqual([]);
    expect(await store.list("learning")).toEqual([]);
    expect(await store.list("chats")).toEqual([]);
    const day = DateTime.now().setZone("Asia/Taipei").toISODate();
    expect((await store.get("usage", hash(uid + "|" + day)))?.count).toBe(1);
    expect((await store.get("usage", "global-" + day))?.count).toBe(1);
  });

  it.each(["foreign", "failed", "invalid-index"])("rejects %s photo input before reserving any quota", async (scenario) => {
    const { domain, store } = await setup();
    await store.set("jobs", "photo-query", recognition(scenario === "foreign" ? "someone-else" : uid, scenario === "failed" ? "failed" : "succeeded"));
    await expect(domain.enqueueJob(uid, true, "explanation", { recognitionId: "photo-query", medicationIndex: scenario === "invalid-index" ? 1 : 0 }, "invalid-photo-query")).rejects.toMatchObject({ code: scenario === "foreign" ? "not_found" : "invalid_recognition" });
    expect(await store.list("usage")).toEqual([]);
    expect((await store.list("jobs")).length).toBe(1);
  });

  it("invalidates a completed explanation when its saved medication changes or is archived", async () => {
    const { domain, store } = await setup();
    const medication = await domain.saveMedication(uid, query);
    const job = await complete(domain, { medicationId: medication.id });
    expect((await domain.publicJob(uid, job)).result).not.toBeNull();
    await store.set("medications", medication.id, { ...medication, revision: medication.revision + 1, name: "另一款藥" });
    expect(await domain.publicJob(uid, job)).toMatchObject({ result: null, explanationUpdateRequired: true, error: { code: "stale_content" } });
    await store.set("medications", medication.id, { ...medication, archived: true });
    expect((await domain.publicJob(uid, job)).result).toBeNull();
  });

  it("invalidates a photo query after its recognition source is removed", async () => {
    const { domain, store } = await setup();
    await store.set("jobs", "photo-query", recognition());
    const job = await complete(domain, { recognitionId: "photo-query", medicationIndex: 0 });
    await store.delete("jobs", "photo-query");
    expect(await domain.publicJob(uid, job)).toMatchObject({ result: null, explanationUpdateRequired: true });
  });

  it("uses the confirmed catalog snapshot and invalidates when that product changes", async () => {
    const { domain } = await setup();
    let drug: Drug = { licenseNo: "SYNTHETIC-GENERAL-LICENSE", nameZh: query.name, nameEn: "Synthetic cream", strength: query.strength, form: query.form, ingredients: ["SYNTHETIC-INGREDIENT"], revoked: false };
    domain.catalog.all = async () => [drug];
    const medication = await domain.saveMedication(uid, { ...query,
      identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    });
    domain.catalog.get = vi.fn(async () => { throw Error("must use the same verified snapshot"); });
    const job = await complete(domain, { medicationId: medication.id });
    expect((job.result as DrugExplanationResult).identityStatus).toBe("confirmed");
    expect((await domain.publicJob(uid, job)).result).not.toBeNull();
    drug = { ...drug, ingredients: ["CHANGED-CATALOG-INGREDIENT"] };
    expect(await domain.publicJob(uid, job)).toMatchObject({ result: null, explanationUpdateRequired: true });
  });

  it("retries a failed explanation without reserving a second daily use", async () => {
    const { domain, store, json } = await setup();
    json.mockRejectedValueOnce(new Error("synthetic transient generation failure"));
    const job = await domain.enqueueJob(uid, true, "explanation", { query }, "retry-general-explanation");
    await domain.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({ status: "failed" });
    await domain.retryJob(uid, job.id);
    await domain.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
    const day = DateTime.now().setZone("Asia/Taipei").toISODate();
    expect((await store.get("usage", hash(uid + "|" + day)))?.count).toBe(1);
  });

  it("discards a generation if the source medication changes during search", async () => {
    const { domain, store, searchReferences } = await setup();
    const medication = await domain.saveMedication(uid, query);
    searchReferences.mockImplementationOnce(async () => {
      await store.set("medications", medication.id, { ...medication, revision: medication.revision + 1 });
      return search;
    });
    const job = await domain.enqueueJob(uid, true, "explanation", { medicationId: medication.id }, "changing-general-product");
    await domain.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({ status: "failed", error: { code: "stale_content" }, result: null });
    expect(await store.list("learning")).toEqual([]);
  });

  it("serves the authenticated endpoint and rejects mixed or prescription-bearing requests", async () => {
    const { domain, store } = await setup();
    const app = createApp(domain, async () => identity);
    const response = await app.request("/api/v1/explanations", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "api-general-information" }, body: JSON.stringify({ query }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued" });
    for (const input of [{ query, medicationId: "other" }, { query: { ...query, doseAmount: 2 } }, { recognitionId: "photo-query", medicationIndex: -1 }]) {
      expect(DrugExplanationRequestSchema.safeParse(input).success).toBe(false);
      const invalid = await app.request("/api/v1/explanations", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "invalid-general-information" }, body: JSON.stringify(input) });
      expect(invalid.status).toBe(400);
    }
    expect(await store.list("jobs")).toHaveLength(1);
  });

  it("keeps ordinary quota and verified-account admission on general queries", async () => {
    const { domain, store } = await setup();
    await expect(domain.enqueueJob(uid, false, "explanation", { query }, "not-verified-query")).rejects.toMatchObject({ code: "email_unverified" });
    const day = DateTime.now().setZone("Asia/Taipei").toISODate();
    await store.set("usage", hash(uid + "|" + day), { count: config.userLimit });
    await expect(domain.enqueueJob(uid, true, "explanation", { query }, "exhausted-query")).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await store.list("jobs")).toEqual([]);
  });
});

describe("general query evidence boundaries", () => {
  const catalogDrug: Drug = {
    licenseNo: "SYNTHETIC-EXACT-REGISTRATION", nameZh: "合成膜衣錠５００毫克",
    nameEn: "SYNTHETIC FILM COATED TABLETS 500MG", strength: "500毫克",
    form: "膜衣錠", ingredients: ["SYNTHETIC (EQ TO SYNTHETICALIAS)"], revoked: false,
  };
  const splitQuery = { name: "合成膜衣錠", strength: "500mg", form: "錠劑" };

  it("enriches only a unique full registered name with a known separately printed strength", () => {
    expect(exactGeneralReferenceMatch([catalogDrug], splitQuery)).toEqual({ drug: catalogDrug, matchBasis: "complete_name_and_strength" });
    expect(exactGeneralReferenceMatch([catalogDrug, { ...catalogDrug, licenseNo: "REVOKED", revoked: true }], splitQuery)?.drug).toEqual(catalogDrug);
  });

  it.each([
    { ...splitQuery, name: "合成" },
    { ...splitQuery, strength: "250mg" },
    { ...splitQuery, strength: "0.5g" },
    { ...splitQuery, form: "膠囊" },
    { ...splitQuery, licenseNo: "OTHER-REGISTRATION" },
  ])("does not enrich a partial, conflicting or converted query: %j", (input) => {
    expect(exactGeneralReferenceMatch([catalogDrug], input)).toBeNull();
  });

  it("leaves ambiguous active registrations and revoked products as literal-only queries", () => {
    expect(exactGeneralReferenceMatch([catalogDrug, { ...catalogDrug, licenseNo: "SECOND-ACTIVE" }], splitQuery)).toBeNull();
    expect(exactGeneralReferenceMatch([{ ...catalogDrug, revoked: true }], splitQuery)).toBeNull();
  });

  it("uses an exact official catalog snapshot for search without confirming the user's product", async () => {
    const { domain, store, searchReferences } = await setup();
    const row: Drug = { ...catalogDrug, nameZh: query.name, nameEn: "Synthetic cream", strength: query.strength, form: query.form };
    const blobs = { get: vi.fn(async (path: string) => Buffer.from(JSON.stringify([
      path.includes("v2") ? { ...row, ingredients: ["CHANGED-INGREDIENT"] } : row,
    ]))) };
    domain.catalog = new Catalog(store, blobs as unknown as Blobs);
    await store.set("settings", "catalog", { source: GENERAL_CATALOG_SOURCE, version: "v1", path: "catalog/v1.json" });
    const job = await complete(domain, { query });
    expect((job.result as DrugExplanationResult).identityStatus).toBe("unverified");
    expect((job.result as DrugExplanationResult).catalogReference).toMatchObject({ sourceUrl: GENERAL_CATALOG_SOURCE, catalogVersion: "v1", nameZh: query.name, matchBasis: "complete_name" });
    expect(searchReferences.mock.calls[0][0][0]).toMatchObject({ identityVerified: false, queriedName: query.name, ingredients: row.ingredients });
    expect((await domain.publicJob(uid, job)).result).not.toBeNull();
    expect(blobs.get).toHaveBeenCalledTimes(1);
    expect(await store.list("medications")).toEqual([]);
    await store.set("settings", "catalog", { source: GENERAL_CATALOG_SOURCE, version: "v2", path: "catalog/v2.json" });
    expect(await domain.publicJob(uid, job)).toMatchObject({ result: null, explanationUpdateRequired: true });
    expect(blobs.get).toHaveBeenCalledTimes(2);
  });

  it("does not treat an unverified catalog source as authoritative enrichment", async () => {
    const { store } = await setup();
    const blobs = { get: vi.fn(async () => Buffer.from(JSON.stringify([catalogDrug]))) };
    const catalog = new Catalog(store, blobs as unknown as Blobs);
    await store.set("settings", "catalog", { source: "https://untrusted.example/catalog", version: "v1", path: "catalog/v1.json" });
    expect(await catalog.generalReference(splitQuery)).toBeNull();
    expect(blobs.get).not.toHaveBeenCalled();
  });

  it("uses only explicitly declared EQ TO ingredient aliases for reference relevance", () => {
    expect(relevantReferenceText("SYNTHETICALIAS is the name in this source.", [catalogDrug])).toBe(true);
    expect(relevantReferenceText("SYNTHETIC has information in this source.", [catalogDrug])).toBe(true);
    expect(relevantReferenceText("UNKNOWNALIAS in a different source.", [catalogDrug])).toBe(false);
    expect(relevantReferenceText("UNKNOWNALIAS", [{ ...catalogDrug, ingredients: ["SYNTHETIC (possible UNKNOWNALIAS)"] }])).toBe(false);
  });

  it("asks for a usable name instead of guessing a generic medicine or appearance", async () => {
    const json = vi.fn(), searchReferences = vi.fn();
    const result = await explainDrug({ json, searchReferences }, { name: "感冒藥", strength: "", form: "" });
    expect(result.status).toBe("insufficient_data");
    expect(result.assistance?.uncertainties.join("")).toContain("完整藥名");
    expect(searchReferences).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("does not invent advice when search is unavailable or supplied links are untrusted", async () => {
    for (const candidate of [{ state: "unavailable" as const, sources: [], passages: [] }, { ...search, sources: [{ ...source, url: "https://untrusted.example/advice" }] }]) {
      const json = vi.fn();
      const result = await explainDrug({ json, searchReferences: async () => candidate }, query);
      expect(result.status).toBe("insufficient_data");
      expect(result.assistance?.claims).toEqual([]);
      expect(result.assistance?.sources).toEqual([]);
      expect(json).not.toHaveBeenCalled();
    }
  });

  it("rejects a claim with an invented evidence quote even if its URL is allowed", async () => {
    const json = vi.fn(async () => ({ status: "answered", claims: [{ ...claim, evidenceQuotes: [{ sourceId: source.id, quote: "這段引文並不存在於任何讀取到的來源內容。" }] }] }));
    const result = await explainDrug({ json, searchReferences: async () => search }, query);
    expect(result.assistance?.claims).toEqual([]);
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("retains a verified claim when storage or usage precautions remain unconfirmed", async () => {
    const json = vi.fn(async (_prompt: string, input: any) => input.expectedIds
      ? { decisions: [{ id: "0", supported: true }] }
      : { status: "answered", unconfirmedTopics: ["保存方式", "使用注意"], claims: [claim] });
    const result = await explainDrug({ json, searchReferences: async () => search }, query);
    expect(result.status).toBe("supported");
    expect(result.assistance?.claims).toHaveLength(1);
    expect(result.assistance?.uncertainties.join("")).toContain("保存方式、使用注意");
    expect(result.assistance?.uncertainties.join("")).not.toContain("格式無法核對");
    expect(json).toHaveBeenCalledTimes(2);
  });

  it("keeps short Chinese names searchable without inventing an ingredient", () => {
    const product = { licenseNo: "", nameZh: "合成藥", nameEn: "", strength: "", form: "乳膏", ingredients: [], revoked: false, identityVerified: false };
    expect(relevantReferenceText("合成藥：這是一段來源原文。", [product])).toBe(true);
    expect(relevantReferenceText("另外一種同樣顏色的藥品。", [product])).toBe(false);
    expect(JSON.parse(referenceSearchRequest([product], "synthetic-model").input).products[0]).toMatchObject({ nameZh: "合成藥", ingredients: [], identityVerified: false });
  });
});
