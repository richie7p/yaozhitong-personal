import { describe, expect, it, vi } from "vitest";
import { Domain, hash } from "../server/domain";
import { Catalog } from "../server/catalog";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { GROUNDING_VERSION } from "../server/ai";
import { Blobs } from "../server/blobs";
import type { Drug, GroundedResult, Identity, Job } from "../shared/schema";

const drug: Drug = {
  licenseNo: "SYNTHETIC-IDENTITY-1",
  nameZh: "完整合成糖漿",
  nameEn: "Complete synthetic syrup",
  strength: "5mg/5mL",
  form: "糖漿劑",
  ingredients: [],
  revoked: false,
};
const identity: Identity = {
  uid: "identity-owner",
  email: "identity@example.invalid",
  name: "合成測試",
  verified: true,
  admin: false,
};
const input = {
  name: drug.nameZh,
  licenseNo: drug.licenseNo,
  confirmed: true,
  doseAmount: 1,
  doseUnit: "mL",
  frequencyRaw: "QD",
};
const proof = { method: "license" as const, printedLicenseNo: drug.licenseNo };
const result: GroundedResult = {
  status: "supported",
  claims: [],
  chunks: [],
  quiz: [],
  followups: [],
  rejectedCount: 0,
  sourceVersions: {},
  verification: "model_assisted",
};
async function setup() {
  const store = new MemoryStore();
  const blobs = new Blobs();
  const json = vi.fn(async () => ({ status: "not_found", claims: [] }));
  const factory = vi.fn(() => ({ json }));
  const domain = new Domain(store, blobs, factory);
  let rows = [drug];
  domain.catalog.all = async () => rows;
  await domain.account(identity);
  const app = createApp(domain, async () => identity);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request("/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "identity-test-operation",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: (await response.json()) as any };
  };
  return {
    store,
    blobs,
    domain,
    json,
    factory,
    request,
    setRows: (next: Drug[]) => {
      rows = next;
    },
  };
}

describe("server product identity admission and history", () => {
  it("keeps confirmed usage and partial evidence while clearing unproven canonical licenses", async () => {
    const { domain, store } = await setup();
    const saved = await domain.saveMedication(identity.uid, {
      ...input,
      identityReview: { status: "confirmed" },
      identityEvidence: { method: "details", printedName: "部分" },
    });
    expect(saved).toMatchObject({
      confirmed: true,
      licenseNo: null,
      candidateLicenseNo: drug.licenseNo,
      identityEvidence: { printedName: "部分" },
      identityReview: { status: "needs_information" },
    });
    expect(await store.get("medications", saved.id)).not.toHaveProperty(
      "identityReview",
    );
    expect(
      (await domain.medications(identity.uid))[0].identityReview?.status,
    ).toBe("needs_information");
  });
  it("checks identity for an ordinary active account without eligibility, AI, usage, or blobs", async () => {
    const { store, request, factory, blobs } = await setup();
    await store.set("users", identity.uid, {
      ...(await store.get("users", identity.uid)),
      eligible: false,
    });
    const put = vi.spyOn(blobs, "put");
    const checked = await request("/medications/identity-check", "POST", {
      identityEvidence: proof,
      identityReview: { status: "confirmed" },
    });
    expect(checked.response.status).toBe(200);
    expect(checked.body.identityReview).toMatchObject({
      status: "confirmed",
      candidate: drug,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await store.list("jobs")).toEqual([]);
    expect(await store.list("usage")).toEqual([]);
  });
  it.each(["bundle", "chat", "interaction"] as const)(
    "rejects pending %s before any job, quota or model work",
    async (kind) => {
      const { domain, store, factory } = await setup();
      const first = await domain.saveMedication(identity.uid, input);
      const second = await domain.saveMedication(identity.uid, input);
      await expect(
        domain.enqueueJob(
          identity.uid,
          true,
          kind,
          {
            medicationIds:
              kind === "interaction" ? [first.id, second.id] : [first.id],
          },
          "identity-pending-operation",
        ),
      ).rejects.toMatchObject({ code: "identity_unconfirmed" });
      expect(factory).not.toHaveBeenCalled();
      expect(await store.list("jobs")).toEqual([]);
      expect(await store.list("usage")).toEqual([]);
    },
  );
  it("accepts a proven license and refuses unconfirmed usage before charging", async () => {
    const { domain, store } = await setup();
    const medication = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: proof,
      confirmed: false,
    });
    expect(medication.licenseNo).toBe(drug.licenseNo);
    await expect(
      domain.enqueueJob(
        identity.uid,
        true,
        "bundle",
        { medicationIds: [medication.id] },
        "identity-usage-operation",
      ),
    ).rejects.toMatchObject({ code: "unconfirmed_usage" });
    expect(await store.list("usage")).toEqual([]);
  });
  it("rechecks current catalog metadata instead of trusting legacy licenses or client status", async () => {
    const { domain, store, setRows } = await setup();
    const med = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: {
        method: "details",
        printedName: drug.nameZh,
        printedStrength: drug.strength,
        printedForm: drug.form,
      },
    });
    expect(med.identityReview?.status).toBe("confirmed");
    setRows([{ ...drug, strength: "10mg/5mL" }]);
    expect(
      (await domain.medications(identity.uid))[0].identityReview?.status,
    ).toBe("needs_information");
    const legacy = {
      ...(await store.get("medications", med.id)),
      identityEvidence: undefined,
      identityReview: { status: "confirmed" },
    };
    await store.set("medications", med.id, legacy);
    await expect(
      domain.enqueueJob(
        identity.uid,
        true,
        "chat",
        { medicationIds: [med.id] },
        "identity-legacy-operation",
      ),
    ).rejects.toMatchObject({ code: "identity_unconfirmed" });
    expect(await store.list("usage")).toEqual([]);
  });
  it("rechecks recovered workers before any model/cache consumption and does not recharge", async () => {
    const { domain, store, factory, json } = await setup();
    const medication = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: proof,
    });
    const job = await domain.enqueueJob(
      identity.uid,
      true,
      "bundle",
      { medicationIds: [medication.id] },
      "identity-worker-operation",
    );
    await domain.saveMedication(
      identity.uid,
      { ...input, identityEvidence: null },
      medication.id,
    );
    factory.mockClear();
    await domain.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({
      status: "failed",
      error: { code: "identity_unconfirmed" },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(await store.list("generated")).toEqual([]);
    expect(await store.list("learning")).toEqual([]);
    expect((await store.list("usage")).every((row) => row.count === 1)).toBe(
      true,
    );
    await expect(domain.retryJob(identity.uid, job.id)).rejects.toMatchObject({
      code: "identity_unconfirmed",
    });
  });
  it("hides legacy or changed chat/learning and sanitizes individual and listed old job results", async () => {
    const { domain, store, request } = await setup();
    const med = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: proof,
    });
    const row = {
      id: "historic",
      ownerId: identity.uid,
      medicationIds: [med.id],
      medicationRevisions: [{ id: med.id, revision: med.revision }],
      profileVersion: 0,
      groundingVersion: GROUNDING_VERSION,
      result,
      answers: {},
      createdAt: new Date().toISOString(),
    };
    await store.set("learning", row.id, row);
    await store.set("chats", row.id, row);
    const job: Job = {
      id: row.id,
      ownerId: identity.uid,
      kind: "chat",
      status: "succeeded",
      input: {},
      result,
      error: null,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      leaseUntil: 0,
      attempts: 1,
    };
    await store.set("jobs", job.id, job);
    expect(await domain.learningCurrent(identity.uid, row)).toBe(true);
    expect((await request("/chat")).body.items).toHaveLength(1);
    await domain.saveMedication(identity.uid, input, med.id);
    expect(await domain.learningCurrent(identity.uid, row)).toBe(false);
    expect((await request("/chat")).body).toMatchObject({
      items: [],
      hiddenUnsafeCount: 1,
      identityReviewRequired: true,
    });
    expect((await request("/learning")).body.items).toEqual([]);
    expect((await request("/jobs/historic")).body).toMatchObject({
      identityReviewRequired: true,
      result: { status: "insufficient_data", claims: [], chunks: [] },
    });
    expect((await request("/jobs")).body.items[0]).toMatchObject({
      result: null,
      resultRequiresCheck: true,
    });
    expect((await store.get<Job>("jobs", job.id))?.result).toEqual(result);
  });
  it("normalizes recognition saves and preserves the lost-response idempotency guard", async () => {
    const { domain, store } = await setup();
    await store.set("jobs", "recognition", {
      id: "recognition",
      ownerId: identity.uid,
      kind: "recognition",
      status: "succeeded",
      result: { medications: [{}] },
    });
    const first = await domain.saveRecognizedMedication(
      identity.uid,
      "recognition",
      0,
      input,
    );
    const second = await domain.saveRecognizedMedication(
      identity.uid,
      "recognition",
      0,
      input,
    );
    expect(first.id).toBe(second.id);
    expect(first.licenseNo).toBeNull();
    expect(await store.list("medications")).toHaveLength(1);
    await expect(
      domain.saveRecognizedMedication(identity.uid, "recognition", 0, {
        ...input,
        identityEvidence: proof,
      }),
    ).rejects.toMatchObject({ code: "recognition_saved_conflict" });
    // A replay of a pre-feature save is normalized for comparison without a
    // cloud migration or silently rewriting the legacy record.
    const legacy: Record<string, unknown> = {
      ...(await store.get("medications", first.id)),
      licenseNo: drug.licenseNo,
    };
    delete legacy.candidateLicenseNo;
    delete legacy.identityEvidence;
    await store.set("medications", first.id, legacy);
    expect(
      (
        await domain.saveRecognizedMedication(
          identity.uid,
          "recognition",
          0,
          input,
        )
      ).identityReview?.status,
    ).toBe("needs_information");
    expect((await store.get("medications", first.id))?.licenseNo).toBe(
      drug.licenseNo,
    );
  });
  it("checks a new catalog version immediately while reusing the unchanged blob/index", async () => {
    const store = new MemoryStore();
    const blobs = new Blobs();
    const get = vi.spyOn(blobs, "get").mockImplementation(async (key) =>
      Buffer.from(
        JSON.stringify([
          {
            ...drug,
            strength: key === "catalog-v1" ? drug.strength : "10mg/5mL",
          },
        ]),
      ),
    );
    const catalog = new Catalog(store, blobs);
    const details = {
      identityEvidence: {
        method: "details" as const,
        printedLicenseNo: "",
        printedName: drug.nameZh,
        printedStrength: drug.strength,
        printedForm: drug.form,
      },
    };
    await store.set("settings", "catalog", {
      version: "v1",
      path: "catalog-v1",
    });
    expect((await catalog.identityReview(details)).status).toBe("confirmed");
    expect((await catalog.identityReview(details)).status).toBe("confirmed");
    expect(get).toHaveBeenCalledTimes(1);
    await store.set("settings", "catalog", {
      version: "v2",
      path: "catalog-v2",
    });
    expect((await catalog.identityReview(details)).status).toBe(
      "needs_information",
    );
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("shares repeated history safety reads only within one request", async () => {
    const { domain, store } = await setup();
    const med = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: proof,
    });
    await store.set("published", hash(drug.licenseNo), {
      leafletId: "current-leaflet",
    });
    await store.set("leaflets", "current-leaflet", {
      status: "published",
      version: "v1",
    });
    for (let i = 0; i < 20; i++)
      await store.set("chats", `history-${i}`, {
        id: `history-${i}`,
        ownerId: identity.uid,
        medicationIds: [med.id],
        medicationRevisions: [{ id: med.id, revision: med.revision }],
        profileVersion: 0,
        groundingVersion: GROUNDING_VERSION,
        result: { ...result, sourceVersions: { [drug.licenseNo]: "v1" } },
      });
    const get = vi.spyOn(store, "get");
    expect((await domain.chatHistory(identity.uid)).items).toHaveLength(20);
    for (const [collection, id] of [
      ["users", identity.uid],
      ["medications", med.id],
      ["published", hash(drug.licenseNo)],
      ["leaflets", "current-leaflet"],
    ])
      expect(
        get.mock.calls.filter(([c, key]) => c === collection && key === id),
      ).toHaveLength(1);
    await store.set("medications", med.id, {
      ...(await store.get("medications", med.id)),
      identityEvidence: null,
    });
    expect((await domain.chatHistory(identity.uid)).items).toHaveLength(0);
  });
  it("lists job summaries without reading each record, medication or source", async () => {
    const { store, request } = await setup();
    for (let i = 0; i < 30; i++)
      await store.set("jobs", `job-${i}`, {
        id: `job-${i}`,
        ownerId: identity.uid,
        kind: "chat",
        status: "succeeded",
        input: {},
        result,
        createdAt: new Date().toISOString(),
      });
    const get = vi.spyOn(store, "get");
    const response = await request("/jobs");
    expect(response.body.items).toHaveLength(30);
    expect(
      response.body.items.every(
        (row: any) => row.result === null && row.resultRequiresCheck,
      ),
    ).toBe(true);
    expect(
      get.mock.calls.filter(([collection]) =>
        ["chats", "learning", "medications", "published", "leaflets"].includes(
          collection,
        ),
      ),
    ).toHaveLength(0);
  });
  it("rechecks identity after reading a generation cache and before exposing its content", async () => {
    const { domain, store, json } = await setup();
    const med = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: proof,
    });
    const job = await domain.enqueueJob(
      identity.uid,
      true,
      "chat",
      { medicationIds: [med.id] },
      "identity-cache-race",
    );
    const originalGet = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation(async (collection, id) => {
      if (collection === "generated") {
        await store.set("medications", med.id, {
          ...(await originalGet("medications", med.id)),
          identityEvidence: null,
        });
        return { result } as any;
      }
      return originalGet(collection, id);
    });
    await domain.processJob(job.id);
    expect(await originalGet("jobs", job.id)).toMatchObject({
      status: "failed",
      error: { code: "identity_unconfirmed" },
    });
    expect(json).not.toHaveBeenCalled();
    expect(await store.list("chats")).toEqual([]);
  });
  it("rejects a catalog metadata race before committing generated or historical content", async () => {
    const { domain, store, setRows } = await setup();
    const med = await domain.saveMedication(identity.uid, {
      ...input,
      identityEvidence: {
        method: "details",
        printedName: drug.nameZh,
        printedStrength: drug.strength,
        printedForm: drug.form,
      },
    });
    const job = await domain.enqueueJob(
      identity.uid,
      true,
      "bundle",
      { medicationIds: [med.id] },
      "identity-commit-race",
    );
    const originalTransaction = store.transaction.bind(store);
    let transactions = 0;
    vi.spyOn(store, "transaction").mockImplementation(async (callback) => {
      transactions++;
      if (transactions === 2) setRows([{ ...drug, strength: "10mg/5mL" }]);
      return originalTransaction(callback);
    });
    await domain.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({
      status: "failed",
      error: { code: "identity_unconfirmed" },
    });
    expect(await store.list("generated")).toEqual([]);
    expect(await store.list("learning")).toEqual([]);
  });
});
