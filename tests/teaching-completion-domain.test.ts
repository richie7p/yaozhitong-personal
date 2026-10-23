import { beforeEach, expect, it, vi } from "vitest";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { GROUNDING_VERSION } from "../server/ai";
import type {
  Drug,
  GroundedResult,
  Job,
  LearningRecord,
} from "../shared/schema";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../server/ai", async (original) => ({
  ...(await original<typeof import("../server/ai")>()),
  grounded: generate,
}));
vi.mock("../server/source-review-result", async (original) => ({
  ...(await original<typeof import("../server/source-review-result")>()),
  withSourceReviewResult: (action: () => unknown) => action(),
}));
const uid = "synthetic-completion-owner";
const drug: Drug = {
  licenseNo: "SYNTHETIC-COMPLETION",
  nameZh: "合成補齊測試錠",
  nameEn: "Synthetic completion",
  strength: "",
  form: "錠",
  ingredients: [],
  revoked: false,
};
const partial: GroundedResult = {
  status: "supported",
  claims: [],
  chunks: [],
  quiz: [],
  followups: [],
  rejectedCount: 0,
  sourceVersions: { [drug.licenseNo]: "v1" },
  verification: "model_assisted",
  plainLanguageCoverage: {
    scope: "recognized_source_fields",
    status: "partial",
    fields: [],
  },
};
beforeEach(() => {
  generate.mockReset();
  generate.mockResolvedValue(structuredClone(partial));
});
async function fixture() {
  const store = new MemoryStore();
  const d = new Domain(store, undefined, () => ({ json: vi.fn() }));
  d.catalog.all = async () => [drug];
  d.catalog.get = async () => drug;
  await d.account({
    uid,
    name: "合成帳號",
    email: "completion@example.invalid",
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
  await store.set("leaflets", "synthetic-leaflet", {
    id: "synthetic-leaflet",
    licenseNo: drug.licenseNo,
    version: "v1",
    sha256: "synthetic-sha",
    status: "published",
    chunks: [
      {
        id: "source",
        licenseNo: drug.licenseNo,
        version: "v1",
        page: 1,
        start: 0,
        text: "適應症：合成軟體測試。",
      },
    ],
  });
  await store.set("published", hash(drug.licenseNo), {
    leafletId: "synthetic-leaflet",
  });
  const input = { medicationIds: [med.id] };
  const oldJob = await d.enqueueJob(
    uid,
    true,
    "bundle",
    input,
    "completion-original",
  );
  await d.processJob(oldJob.id);
  const previous = (await store.get<LearningRecord>("learning", oldJob.id))!;
  expect(previous.groundingVersion).toBe(GROUNDING_VERSION);
  await store.set("learning", previous.id, {
    ...previous,
    answers: { "saved-original": 1 },
  });
  const before = structuredClone(await store.get("learning", previous.id));
  const completion = { ...input, previousLearningId: previous.id };
  return { d, store, med, input, previous, before, completion };
}
it("forks a partial cache, charges once on repeated same-key submission and preserves old answers", async () => {
  const { d, store, input, previous, before, completion } = await fixture();
  const jobs = await Promise.all(
    Array.from({ length: 12 }, () =>
      d.enqueueJob(uid, true, "bundle", completion, "completion-new-key"),
    ),
  );
  expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
  generate.mockResolvedValue({
    ...structuredClone(partial),
    plainLanguageCoverage: {
      scope: "recognized_source_fields",
      status: "complete",
      fields: [],
    },
  });
  await d.processJob(jobs[0].id);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(await store.get("learning", previous.id)).toEqual(before);
  expect(await store.get("learning", jobs[0].id)).toMatchObject({
    answers: {},
    result: { plainLanguageCoverage: { status: "complete" } },
  });
  expect((await store.list("usage")).every((row) => row.count === 2)).toBe(
    true,
  );
  // A normal request still consumes the original cache; completed historical
  // records do not all expire merely because a partial record was completed.
  const normal = await d.enqueueJob(
    uid,
    true,
    "bundle",
    input,
    "completion-normal-key",
  );
  await d.processJob(normal.id);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(await store.get<Job>("jobs", normal.id)).toMatchObject({
    result: { plainLanguageCoverage: { status: "partial" } },
  });
});
it("regenerates selectively rejected cached wording without modifying historical learning or answers", async () => {
  const { d, store, input, previous, before } = await fixture();
  const cached = (await store.list("generated"))[0];
  await store.set("generated", cached.id, {
    ...cached,
    result: {
      ...partial,
      claims: [
        {
          text: "洗眼不要超過30秒。",
          category: "warning",
          citations: [{ chunkId: "source", quote: "請勿洗眼30秒以上。" }],
        },
      ],
    },
  });
  const job = await d.enqueueJob(
    uid,
    true,
    "bundle",
    input,
    "completion-reject-old-cache",
  );
  await d.processJob(job.id);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(await store.get<Job>("jobs", job.id)).toMatchObject({
    status: "succeeded",
    result: { claims: [] },
  });
  expect(await store.get("learning", previous.id)).toEqual(before);
});
it.each([
  "other-owner",
  "wrong-medication",
  "changed-revision",
  "changed-profile",
  "complete",
  "source-held",
  "chat",
])("rejects %s before creating a job or charging usage", async (scenario) => {
  const { d, store, med, previous, completion } = await fixture();
  let kind: "bundle" | "chat" = "bundle";
  if (scenario === "other-owner")
    await store.set("learning", previous.id, {
      ...previous,
      ownerId: "synthetic-other",
    });
  if (scenario === "wrong-medication")
    completion.medicationIds = [(await d.saveMedication(uid, med)).id];
  if (scenario === "changed-revision")
    await store.set("medications", med.id, {
      ...med,
      revision: med.revision + 1,
    });
  if (scenario === "changed-profile")
    await store.set("users", uid, {
      ...(await store.get("users", uid)),
      profileVersion: 1,
    });
  if (scenario === "complete")
    await store.set("learning", previous.id, {
      ...previous,
      result: {
        ...partial,
        plainLanguageCoverage: {
          scope: "recognized_source_fields",
          status: "complete",
          fields: [],
        },
      },
    });
  if (scenario === "source-held")
    await store.set("learning", previous.id, {
      ...previous,
      result: {
        ...partial,
        sourceReview: { reason: "safety_sections_pending", sources: [] },
      },
    });
  if (scenario === "chat") kind = "chat";
  await expect(
    d.enqueueJob(uid, true, kind, completion, "completion-rejected"),
  ).rejects.toMatchObject({ code: expect.any(String) });
  expect(await store.list("jobs")).toHaveLength(1);
  expect((await store.list("usage")).every((row) => row.count === 1)).toBe(
    true,
  );
});
