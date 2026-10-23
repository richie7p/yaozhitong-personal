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
  expect(generate.mock.calls[0][3]).not.toHaveProperty("previousTeaching");
  expect(generate.mock.calls[1][3].previousTeaching).toEqual(before!.result);
  expect(generate.mock.calls[1][3]).not.toHaveProperty("answers");
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
it("uses only the current server result as incremental context and clones it independently of saved answers", async () => {
  const { d, store, previous, before, completion } = await fixture();
  const job = await d.enqueueJob(
    uid,
    true,
    "bundle",
    {
      ...completion,
      previousTeaching: { status: "supported", untrusted: true },
    },
    "completion-server-context",
  );
  generate.mockImplementationOnce(async (_llm, _question, _chunks, context) => {
    expect(context.previousTeaching).toEqual(before!.result);
    expect(context.previousTeaching).not.toHaveProperty("untrusted");
    expect(context.previousTeaching).not.toHaveProperty("answers");
    context.previousTeaching.followups.push(
      "Synthetic mutation only inside model context",
    );
    return structuredClone(partial);
  });
  await d.processJob(job.id);
  expect(await store.get("learning", previous.id)).toEqual(before);
  expect(await store.get<Job>("jobs", job.id)).toMatchObject({
    status: "succeeded",
  });
});
it.each(["owner", "profile", "source", "removed"])(
  "does not pass %s-stale incremental context to generation after enqueue",
  async (scenario) => {
    const { d, store, previous, completion } = await fixture();
    const job = await d.enqueueJob(
      uid,
      true,
      "bundle",
      completion,
      "completion-worker-recheck",
    );
    if (scenario === "owner")
      await store.set("learning", previous.id, {
        ...previous,
        ownerId: "synthetic-other",
      });
    if (scenario === "profile")
      await store.set("users", uid, {
        ...(await store.get("users", uid)),
        profileVersion: 99,
      });
    if (scenario === "source")
      await store.set("leaflets", "synthetic-leaflet", {
        ...(await store.get("leaflets", "synthetic-leaflet")),
        status: "draft",
      });
    if (scenario === "removed") await store.delete("learning", previous.id);
    await d.processJob(job.id);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await store.get<Job>("jobs", job.id)).toMatchObject({
      status: "failed",
    });
    expect(await store.get("learning", job.id)).toBeNull();
    expect((await store.list("usage")).every((row) => row.count === 2)).toBe(
      true,
    );
  },
);
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
it("regenerates a warning misclassified from an inline reference while leaving normal cached content reusable", async () => {
  const { d, store, input, previous, before } = await fixture();
  const cached = (await store.list("generated"))[0];
  const quote = "【警語】)所記載。本段仍為藥理說明。";
  const result = {
    ...structuredClone(partial),
    chunks: [
      {
        id: "source",
        licenseNo: drug.licenseNo,
        version: "v1",
        page: 1,
        start: 0,
        text: "【藥理作用】合成機轉(請參見" + quote,
      },
    ],
    claims: [
      {
        text: "本段仍為藥理說明。",
        category: "warning",
        kind: "source_exact_safety",
        citations: [{ chunkId: "source", quote }],
      },
    ],
  };
  await store.set("generated", cached.id, { ...cached, result });
  const job = await d.enqueueJob(
    uid,
    true,
    "bundle",
    input,
    "completion-inline-reference-cache",
  );
  await d.processJob(job.id);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(await store.get<Job>("jobs", job.id)).toMatchObject({
    status: "succeeded",
    result: { claims: [] },
  });
  expect(await store.get("learning", previous.id)).toEqual(before);
  const normal = await d.enqueueJob(
    uid,
    true,
    "bundle",
    input,
    "completion-valid-refreshed-cache",
  );
  await d.processJob(normal.id);
  expect(generate).toHaveBeenCalledTimes(2);
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
