import { afterEach, expect, it, vi } from "vitest";
import { GROUNDING_VERSION } from "../server/ai";
import { config } from "../server/config";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
const legacyVersion = "grounded-v13-complete-safety-literal-recognition";
const originalMode = config.mode;
afterEach(() => {
  config.mode = originalMode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps v13 history but misses its generated cache and marks it stale after the grounding release changes", async () => {
  config.mode = "local";
  const external = vi
    .fn()
    .mockRejectedValue(Error("No external API in cache regression"));
  vi.stubGlobal("fetch", external);
  const uid = "synthetic-grounding-cache-owner";
  const drug = {
    licenseNo: "SYNTHETIC-GROUNDING-CACHE",
    nameZh: "合成快取測試",
    nameEn: "synthetic cache fixture",
    strength: "",
    form: "錠",
    ingredients: [],
    revoked: false,
  };
  const source = {
    id: "synthetic-cache-source",
    licenseNo: drug.licenseNo,
    version: "synthetic-source-v1",
    page: 1,
    start: 0,
    text: "【適應症】緩解合成測試症狀。\n【警語】對合成成分過敏者請勿使用。",
  };
  const json = vi.fn(async (system: string, input: any) => {
    if (system.includes("審核器"))
      return {
        verdicts: input.expectedIds.map((id: string) => ({
          id,
          supported: true,
        })),
      };
    const warning = input.sources.find((p: any) => p.sourceSection === "警語");
    return {
      status: "supported",
      claims: [
        {
          text: warning.text,
          category: "warning",
          citations: [{ sourceId: warning.id }],
        },
      ],
      quiz: [],
      followups: [],
    };
  });
  const store = new MemoryStore(),
    domain = new Domain(store, undefined, () => ({ json }));
  domain.catalog.get = async () => drug;
  domain.catalog.all = async () => [drug];
  await domain.account({
    uid,
    name: "合成使用者",
    email: "cache@example.invalid",
    verified: true,
    admin: false,
  });
  const med = await domain.saveMedication(uid, {
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    confirmed: true,
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
  });
  await store.set("leaflets", "synthetic-cache-leaflet", {
    id: "synthetic-cache-leaflet",
    licenseNo: drug.licenseNo,
    version: source.version,
    sha256: "synthetic-source-hash",
    status: "published",
    chunks: [source],
  });
  await store.set("published", hash(drug.licenseNo), {
    leafletId: "synthetic-cache-leaflet",
  });
  const input = { medicationIds: [med.id], question: "請說明用途和注意事項。" };
  // Observe the real cache identity rather than duplicating its fields or hash
  // algorithm. Only its release marker changes in this historical fixture.
  let identity: any;
  const stringify = JSON.stringify;
  const observe = vi
    .spyOn(JSON, "stringify")
    .mockImplementation((value: any, ...args: any[]) => {
      if (
        !identity &&
        value?.uid === uid &&
        value?.kind === "chat" &&
        value?.prompt === GROUNDING_VERSION
      )
        identity = structuredClone(value);
      return (stringify as (...args: any[]) => string)(value, ...args);
    });
  const warm = await domain.enqueueJob(
    uid,
    true,
    "chat",
    input,
    "synthetic-cache-warm",
  );
  await domain.processJob(warm.id);
  observe.mockRestore();
  expect(identity).toBeDefined();
  const chat = (await store.get<any>("chats", warm.id))!,
    cached = (await store.list<any>("generated"))[0];
  const legacyId = hash(JSON.stringify({ ...identity, prompt: legacyVersion }));
  const previousResult = {
    ...chat.result,
    claims: chat.result.claims.filter((c: any) => c.category === "warning"),
  };
  const legacyChat = {
    ...chat,
    groundingVersion: legacyVersion,
    result: previousResult,
  };
  const legacyCache = { ...cached, id: legacyId, result: previousResult };
  await store.delete("generated", cached.id);
  await store.set("generated", legacyId, legacyCache);
  await store.set("chats", warm.id, legacyChat);
  json.mockClear();
  expect(GROUNDING_VERSION).not.toBe(legacyVersion);
  expect(await domain.learningCurrent(uid, legacyChat)).toBe(false);
  const next = await domain.enqueueJob(
    uid,
    true,
    "chat",
    input,
    "synthetic-cache-v14-job",
  );
  await domain.processJob(next.id);
  const fresh = (await store.get<any>("chats", next.id))!;
  expect(json).toHaveBeenCalledTimes(2);
  expect(fresh.groundingVersion).toBe(GROUNDING_VERSION);
  expect(fresh.result.status).toBe("supported");
  expect(
    fresh.result.claims.some((c: any) => c.kind === "source_exact_purpose"),
  ).toBe(true);
  expect(fresh.result.claims.some((c: any) => c.category === "warning")).toBe(
    true,
  );
  expect(await domain.learningCurrent(uid, fresh)).toBe(true);
  expect(await store.get("chats", warm.id)).toEqual(legacyChat);
  expect(await store.get("generated", legacyId)).toEqual(legacyCache);
  expect(await store.list("generated")).toHaveLength(2);
  const reused = await domain.enqueueJob(
    uid,
    true,
    "chat",
    input,
    "synthetic-cache-current-reuse",
  );
  await domain.processJob(reused.id);
  expect(json).toHaveBeenCalledTimes(2);
  const reusedJob = await store.get<any>("jobs", reused.id);
  expect(reusedJob).toMatchObject({ status: "succeeded", tokens: 0 });
  expect(reusedJob.aiRequests || []).toEqual([]);
  expect(external).not.toHaveBeenCalled();
});
