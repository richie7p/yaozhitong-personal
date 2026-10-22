import { expect, it, vi } from "vitest";
import { AppError } from "../server/config";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { SOURCE_PAGE_CHAR_LIMIT } from "../shared/source";
import { learningProgress } from "../shared/learning";
import type { Drug, Job, JobKind, Leaflet } from "../shared/schema";

const uid = "synthetic-source-review-owner";
const drug: Drug = {
  licenseNo: "SYNTHETIC-REVIEW",
  nameZh: "合成來源待整理錠",
  nameEn: "Synthetic source review",
  strength: "",
  form: "錠",
  ingredients: [],
  revoked: false,
};

async function setup(
  kind: JobKind = "bundle",
  json = vi.fn(async () => ({ status: "not_found", claims: [] })),
) {
  const store = new MemoryStore();
  const d = new Domain(store, undefined, () => ({ json }));
  d.catalog.all = async () => [drug];
  d.catalog.get = async (license) => (license === drug.licenseNo ? drug : null);
  await d.account({
    uid,
    email: "source-review@example.invalid",
    name: "合成使用者",
    verified: true,
    admin: false,
  });
  const med = await d.saveMedication(uid, {
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
    confirmed: true,
  });
  const leaflet: Leaflet = {
    id: "synthetic-review-leaflet",
    licenseNo: drug.licenseNo,
    version: "synthetic-v1",
    sourceUrl: "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2",
    sha256: "synthetic-sha",
    storagePath: "synthetic/source",
    status: "published",
    checkedBy: "synthetic-reviewer",
    checkedAt: "2026-10-23T00:00:00Z",
    chunks: [
      {
        id: "synthetic-chunk",
        licenseNo: drug.licenseNo,
        version: "synthetic-v1",
        page: 1,
        start: 0,
        text: "警語：合成段落尚未完整",
      },
    ],
  };
  await store.set("leaflets", leaflet.id, leaflet);
  await store.set("published", hash(drug.licenseNo), {
    leafletId: leaflet.id,
    version: leaflet.version,
  });
  const second =
    kind === "interaction" ? await d.saveMedication(uid, med) : null;
  const enqueue = (key = crypto.randomUUID()) =>
    d.enqueueJob(
      uid,
      true,
      kind,
      {
        medicationIds: second ? [med.id, second.id] : [med.id],
        ...(kind === "chat" ? { question: "合成注意事項？" } : {}),
      },
      key,
    );
  const job = await enqueue();
  return { d, store, med, leaflet, job, enqueue, json };
}

it.each(["bundle", "chat", "interaction"] as const)(
  "persists real source holds for %s and reopens them without generated medical content",
  async (kind) => {
    const { d, store, job, json, leaflet, med } = await setup(kind);
    await d.processJob(job.id);
    const saved = (await store.get<Job>("jobs", job.id))!;
    expect(saved).toMatchObject({
      status: "succeeded",
      error: null,
      attempts: 1,
      result: {
        status: "insufficient_data",
        claims: [],
        chunks: [],
        quiz: [],
        followups: [],
        sourceVersions: { [drug.licenseNo]: leaflet.version },
        sourceReview: {
          reason: "safety_sections_pending",
          sources: [
            {
              licenseNo: drug.licenseNo,
              version: leaflet.version,
              sourceUrl: leaflet.sourceUrl,
            },
          ],
        },
      },
    });
    expect(json).not.toHaveBeenCalled();
    const record = await store.get(
      kind === "chat" ? "chats" : "learning",
      job.id,
    );
    expect(record?.result).toEqual(saved.result);
    expect(await d.publicJob(uid, saved)).toMatchObject({
      result: saved.result,
    });
    expect(d.jobSummary(saved)).toMatchObject({
      result: null,
      sourceReviewPending: true,
      resultRequiresCheck: true,
    });
    expect((await store.list("generated"))[0].result).toEqual(saved.result);
    expect(learningProgress(record!.result.quiz, {})).toMatchObject({
      total: 0,
      passed: false,
      status: "unavailable",
    });
    expect((await d.medications(uid))[0].id).toBe(med.id);
    const schedule = await d.saveSchedule(uid, {
      medicationId: med.id,
      times: ["23:59"],
      startDate: "2026-10-23",
    });
    expect(schedule.active).toBe(true);
  },
);

it("preserves old failed-job recovery into a saved pending source state", async () => {
  const { d, store, job } = await setup();
  await store.set("jobs", job.id, {
    ...job,
    status: "failed",
    attempts: 1,
    error: { code: "source_requires_review", message: "舊來源待整理錯誤" },
  });
  await d.retryJob(uid, job.id);
  await d.processJob(job.id);
  expect(await store.get("jobs", job.id)).toMatchObject({
    attempts: 2,
    status: "succeeded",
    error: null,
    result: { sourceReview: { reason: "safety_sections_pending" } },
  });
});

it("rechecks source publication before reopening and regenerates after a source version changes", async () => {
  const { d, store, job, leaflet, enqueue, json } = await setup();
  await d.processJob(job.id);
  const saved = (await store.get<Job>("jobs", job.id))!;
  const next = {
    ...leaflet,
    version: "synthetic-v2",
    sha256: "next-synthetic-sha",
    chunks: leaflet.chunks.map((chunk) => ({
      ...chunk,
      version: "synthetic-v2",
      text: "合成軟體測試資料。",
    })),
  };
  await store.set("leaflets", leaflet.id, next);
  await store.set("published", hash(drug.licenseNo), {
    leafletId: leaflet.id,
    version: next.version,
  });
  const stale = await d.publicJob(uid, saved);
  expect(stale).toMatchObject({
    identityReviewRequired: true,
    result: { status: "insufficient_data", sourceVersions: {} },
  });
  expect((stale.result as any).sourceReview).toBeUndefined();
  const retry = await enqueue();
  await d.processJob(retry.id);
  expect(json).toHaveBeenCalled();
  expect(
    (await store.get("jobs", retry.id))?.result.sourceReview,
  ).toBeUndefined();
});

it.each(["missing", "draft", "retired", "wrong-license"])(
  "does not fabricate official source access for %s source records",
  async (state) => {
    const { d, store, job, leaflet, json } = await setup();
    if (state === "missing")
      await store.delete("published", hash(drug.licenseNo));
    else
      await store.set("leaflets", leaflet.id, {
        ...leaflet,
        ...(state === "wrong-license"
          ? { licenseNo: "SYNTHETIC-OTHER" }
          : { status: state }),
      });
    await d.processJob(job.id);
    const saved = await store.get("jobs", job.id);
    expect(saved).toMatchObject({
      status: "succeeded",
      result: { status: "insufficient_data", sourceVersions: {} },
    });
    expect(saved?.result.sourceReview).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  },
);

it("also retains a full-source size hold without calling the provider", async () => {
  const { d, store, job, leaflet, json } = await setup();
  await store.set("leaflets", leaflet.id, {
    ...leaflet,
    chunks: leaflet.chunks.map((chunk) => ({
      ...chunk,
      text: "合成".repeat(SOURCE_PAGE_CHAR_LIMIT) + "。",
    })),
  });
  await d.processJob(job.id);
  expect(await store.get("jobs", job.id)).toMatchObject({
    result: { sourceReview: { reason: "safety_sections_pending" } },
  });
  expect(json).not.toHaveBeenCalled();
});

it.each([
  "ai_timeout",
  "ai_auth_failed",
  "quota_exceeded",
  "invalid_ai_output",
])("keeps actual %s failures retryable", async (code) => {
  const error = new AppError(code, "合成供應商錯誤", 503);
  const json = vi.fn(async (): Promise<any> => {
    throw error;
  });
  const { d, store, job, leaflet } = await setup("bundle", json);
  await store.set("leaflets", leaflet.id, {
    ...leaflet,
    chunks: leaflet.chunks.map((chunk) => ({
      ...chunk,
      text: "合成軟體測試資料。",
    })),
  });
  await d.processJob(job.id);
  expect(await store.get("jobs", job.id)).toMatchObject({
    status: "failed",
    error: { code },
    input: job.input,
  });
  expect(await store.list("learning")).toHaveLength(0);
  expect(await store.list("generated")).toHaveLength(0);
  await d.retryJob(uid, job.id);
  expect(await store.get("jobs", job.id)).toMatchObject({ status: "queued" });
});

it("does not commit source access when publication is retired during processing", async () => {
  let retire!: () => Promise<void>;
  const json = vi.fn(async (): Promise<any> => {
    await retire();
    throw new AppError("source_requires_review", "合成來源待整理", 422);
  });
  const { d, store, job, leaflet } = await setup("bundle", json);
  const complete = {
    ...leaflet,
    chunks: leaflet.chunks.map((chunk) => ({
      ...chunk,
      text: "合成軟體測試資料。",
    })),
  };
  await store.set("leaflets", leaflet.id, complete);
  retire = () =>
    store.set("leaflets", leaflet.id, { ...complete, status: "retired" });
  await d.processJob(job.id);
  expect(await store.get("jobs", job.id)).toMatchObject({
    status: "failed",
    error: { code: "stale_content" },
  });
  expect(await store.list("learning")).toHaveLength(0);
  expect(await store.list("generated")).toHaveLength(0);
});

it("hides saved source access if a published pointer resolves to another license with the same version", async () => {
  const { d, store, job, leaflet } = await setup();
  await d.processJob(job.id);
  const saved = (await store.get<Job>("jobs", job.id))!;
  await store.set("leaflets", leaflet.id, {
    ...leaflet,
    licenseNo: "SYNTHETIC-WRONG-LICENSE",
  });
  const reopened = await d.publicJob(uid, saved);
  expect(reopened).toMatchObject({
    identityReviewRequired: true,
    result: { status: "insufficient_data", sourceVersions: {} },
  });
  expect((reopened.result as any).sourceReview).toBeUndefined();
  const record = (await store.get("learning", job.id))!;
  expect(await d.learningCurrent(uid, record)).toBe(false);
});
