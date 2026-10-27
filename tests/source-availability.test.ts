import { expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { createApp } from "../server/app";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { config } from "../server/config";
import type { Drug, Identity, Leaflet } from "../shared/schema";

const identity: Identity = {
  uid: "synthetic-free-source-owner",
  email: "source@example.invalid",
  name: "合成來源驗收",
  verified: true,
  admin: false,
};
const drug: Drug = {
  licenseNo: "SYNTHETIC-FREE-SOURCE",
  nameZh: "合成來源藥品",
  nameEn: "Synthetic source",
  strength: "",
  form: "錠",
  ingredients: [],
  revoked: false,
};
async function fixture(state: "available" | "held" | "missing" = "available") {
  const store = new MemoryStore();
  const provider = vi.fn();
  const domain = new Domain(store, undefined, () => ({ json: provider }));
  domain.enqueue = vi.fn().mockResolvedValue(undefined);
  domain.catalog.all = async () => [drug];
  domain.catalog.get = async () => drug;
  await domain.account(identity);
  const med = await domain.saveMedication(identity.uid, {
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
    confirmed: true,
  });
  const leaflet: Leaflet = {
    id: "synthetic-free-source",
    licenseNo: drug.licenseNo,
    version: "synthetic-v1",
    sha256: "synthetic-only",
    status: "published",
    sourceUrl: "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2",
    storagePath: "synthetic-only",
    checkedBy: "synthetic",
    checkedAt: "2026-10-23T00:00:00Z",
    chunks: [
      {
        id: "synthetic-free-chunk",
        licenseNo: drug.licenseNo,
        version: "synthetic-v1",
        page: 1,
        start: 0,
        text:
          state === "held"
            ? "警語：合成段落尚未完成"
            : "警語：合成測試段落完整。",
      },
    ],
  };
  if (state !== "missing") {
    await store.set("leaflets", leaflet.id, leaflet);
    await store.set("published", hash(drug.licenseNo), {
      leafletId: leaflet.id,
    });
  }
  const app = createApp(domain, async () => identity);
  const get = (id = med.id) =>
    app.request("http://test/api/v1/medications/" + id + "/source", {
      headers: { Authorization: "Bearer synthetic" },
    });
  const post = (
    kind = "bundles",
    key = "synthetic-source-operation",
    ids = [med.id],
  ) =>
    app.request("http://test/api/v1/" + kind, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        medicationIds: ids,
        ...(kind === "chat" ? { question: "有什麼注意事項？" } : {}),
      }),
    });
  return { store, domain, med, leaflet, provider, get, post };
}
it.each(["available", "held", "missing"] as const)(
  "inspects %s official sources without a job, provider call, quota or saved-learning mutation",
  async (state) => {
    const { store, get, provider, leaflet, med } = await fixture(state);
    const before = structuredClone(store.data);
    const response = await get();
    expect(response.status).toBe(200);
    const info = await response.json();
    expect(info).toEqual({
      medicationId: med.id,
      medicationRevision: med.revision,
      state: state === "held" ? "needs_review" : state,
      sources:
        state === "missing"
          ? []
          : [
              {
                licenseNo: drug.licenseNo,
                version: leaflet.version,
                sourceUrl: leaflet.sourceUrl,
              },
            ],
    });
    expect(provider).not.toHaveBeenCalled();
    expect(store.data).toEqual(before);
  },
);
it.each(["held", "missing"] as const)(
  "rejects a known %s source at the public text-job boundary before charging",
  async (state) => {
    const { store, domain, med, post, provider } = await fixture(state);
    const second = await domain.saveMedication(identity.uid, med);
    for (const kind of ["bundles", "chat", "interactions"]) {
      const response = await post(
        kind,
        "synthetic-source-operation",
        kind === "interactions" ? [med.id, second.id] : [med.id],
      );
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe(
        state === "held" ? "source_requires_review" : "source_unavailable",
      );
    }
    expect(await store.list("usage")).toEqual([]);
    expect(await store.list("jobs")).toEqual([]);
    expect(await store.list("learning")).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  },
);
it("keeps official originals readable when the daily AI quota is exhausted", async () => {
  const { store, get, post } = await fixture();
  const day = DateTime.now().setZone("Asia/Taipei").toISODate()!;
  await store.set("usage", hash(identity.uid + "|" + day), {
    count: config.userLimit,
  });
  await store.set("usage", "global-" + day, { count: config.globalLimit });
  const before = structuredClone(store.data);
  expect((await get()).status).toBe(200);
  const response = await post();
  expect(response.status).toBe(429);
  expect((await response.json()).code).toBe("quota_exceeded");
  expect(store.data).toEqual(before);
});
it("recovers an already admitted same-key job after a source becomes held without another charge", async () => {
  const { store, post, leaflet } = await fixture();
  const first = await post();
  expect(first.status).toBe(202);
  const { jobId } = await first.json();
  await store.set("leaflets", leaflet.id, {
    ...leaflet,
    chunks: leaflet.chunks.map((chunk) => ({
      ...chunk,
      text: "警語：合成尚未完整",
    })),
  });
  const recovered = await post();
  expect(recovered.status).toBe(202);
  expect((await recovered.json()).jobId).toBe(jobId);
  expect(await store.list("jobs")).toHaveLength(1);
  expect((await store.list("usage")).map((row) => row.count)).toEqual([1, 1]);
});
it.each(["other-owner", "archived", "identity", "disabled", "deleting"])(
  "withholds %s source lookups",
  async (scenario) => {
    const { store, med, get } = await fixture();
    if (scenario === "other-owner")
      await store.set("medications", med.id, {
        ...med,
        ownerId: "synthetic-other",
      });
    if (scenario === "archived")
      await store.set("medications", med.id, { ...med, archived: true });
    if (scenario === "identity")
      await store.set("medications", med.id, {
        ...med,
        licenseNo: undefined,
        name: "未辨識",
        identityEvidence: undefined,
      });
    if (scenario === "disabled" || scenario === "deleting")
      await store.set("users", identity.uid, {
        ...(await store.get("users", identity.uid)),
        [scenario]: true,
      });
    const response = await get();
    expect([403, 404, 409]).toContain(response.status);
    expect((await response.json()).sources).toBeUndefined();
    expect(await store.list("usage")).toEqual([]);
  },
);
it("never returns an untrusted source URL as an official original", async () => {
  const { store, leaflet, get } = await fixture();
  await store.set("leaflets", leaflet.id, {
    ...leaflet,
    sourceUrl: "https://malicious.invalid/fake",
  });
  const response = await get();
  expect((await response.json()).sources).toEqual([
    { licenseNo: drug.licenseNo, version: leaflet.version },
  ]);
});
it("allows source reading before prescription usage is confirmed without allowing an AI task", async () => {
  const { store, med, get, post } = await fixture();
  await store.set("medications", med.id, { ...med, confirmed: false });
  expect((await get()).status).toBe(200);
  const response = await post();
  expect((await response.json()).code).toBe("unconfirmed_usage");
  expect(await store.list("usage")).toEqual([]);
});
it.each(["draft", "retired", "wrong-license"])(
  "does not provide a source reference from a %s publication",
  async (state) => {
    const { store, leaflet, get } = await fixture();
    await store.set("leaflets", leaflet.id, {
      ...leaflet,
      ...(state === "wrong-license"
        ? { licenseNo: "SYNTHETIC-OTHER" }
        : { status: state }),
    });
    const response = await get();
    expect(await response.json()).toMatchObject({
      state: "missing",
      sources: [],
    });
    expect(await store.list("usage")).toEqual([]);
  },
);
