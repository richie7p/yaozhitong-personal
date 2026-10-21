import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../server/config";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Chunk, Drug, GroundedResult, Job } from "../shared/schema";

const originalMode = config.mode;
beforeEach(() => {
  config.mode = "local";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(Error("No external calls in this fixture")),
  );
});
afterEach(() => {
  config.mode = originalMode;
  vi.unstubAllGlobals();
});

const drug: Drug = {
  licenseNo: "SYNTHETIC-CHAT-IDENTITY",
  nameZh: "合成同名處方",
  nameEn: "synthetic record identity fixture",
  strength: "5mg",
  form: "錠",
  ingredients: [],
  revoked: false,
};
const source: Chunk = {
  id: "synthetic-chat-identity-source",
  licenseNo: drug.licenseNo,
  version: "synthetic-v1",
  page: 1,
  start: 0,
  text: "本文件完全為合成資料，僅供軟體流程測試。",
};

async function setup() {
  const store = new MemoryStore();
  const json = vi.fn(async (system: string, input: any) =>
    system.includes("審核器")
      ? {
          verdicts: input.expectedIds.map((id: string) => ({
            id,
            supported: true,
          })),
        }
      : {
          status: "supported",
          claims: [
            {
              text: source.text,
              category: "other",
              citations: [{ sourceId: input.sources[0].id }],
            },
          ],
          quiz: [],
          followups: [],
        },
  );
  const domain = new Domain(store, undefined, () => ({ json }));
  domain.catalog.get = async (licenseNo) =>
    licenseNo === drug.licenseNo ? drug : null;
  for (const uid of ["synthetic-chat-owner", "synthetic-other-owner"])
    await domain.account({
      uid,
      name: "合成一般使用者",
      email: `${uid}@example.invalid`,
      verified: true,
      admin: false,
    });
  await store.set("leaflets", "synthetic-chat-leaflet", {
    id: "synthetic-chat-leaflet",
    licenseNo: drug.licenseNo,
    version: source.version,
    sha256: "synthetic-only",
    status: "published",
    chunks: [source],
  });
  await store.set("published", hash(drug.licenseNo), {
    leafletId: "synthetic-chat-leaflet",
  });
  const medication = (uid: string, doseAmount: number) =>
    domain.saveMedication(uid, {
      name: drug.nameZh,
      licenseNo: drug.licenseNo,
      strength: drug.strength,
      form: drug.form,
      doseAmount,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    });
  return { store, domain, json, medication };
}

it("persists exact selected same-name medication records after the completed chat job clears its input", async () => {
  const { store, domain, json, medication } = await setup();
  const first = await medication("synthetic-chat-owner", 1);
  const second = await medication("synthetic-chat-owner", 2);
  const unselected = await medication("synthetic-chat-owner", 3);
  const selectedIds = [second.id, first.id];
  const question = "這份合成測試資料的用途是什麼？";
  const job = await domain.enqueueJob(
    "synthetic-chat-owner",
    true,
    "chat",
    { question, medicationIds: selectedIds },
    "synthetic-chat-identity-key",
  );
  await domain.processJob(job.id);

  const completed = await store.get<Job>("jobs", job.id);
  expect(completed).toMatchObject({
    status: "succeeded",
    input: {},
    result: { status: "supported" },
  });
  const chat = await store.get<{
    ownerId: string;
    question: string;
    medicationIds: string[];
    result: GroundedResult;
  }>("chats", job.id);
  expect(chat).toMatchObject({
    ownerId: "synthetic-chat-owner",
    question,
    medicationIds: selectedIds,
  });
  expect(chat?.medicationIds).toHaveLength(2);
  expect(chat?.medicationIds).not.toContain(unselected.id);
  expect(chat?.result.claims.map((claim) => claim.text)).toEqual([source.text]);
  expect(first.name).toBe(second.name);
  expect(first.id).not.toBe(second.id);
  expect(json).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();

  await domain.processJob(job.id);
  expect(await store.list("chats")).toHaveLength(1);
  expect((await store.get("chats", job.id))?.medicationIds).toEqual(
    selectedIds,
  );
});

it("does not save a chat or call the model when a selected same-name record belongs to another owner", async () => {
  const { store, domain, json, medication } = await setup();
  const own = await medication("synthetic-chat-owner", 1);
  const foreign = await medication("synthetic-other-owner", 1);
  const job = await domain.enqueueJob(
    "synthetic-chat-owner",
    true,
    "chat",
    {
      question: "合成跨帳號防護測試",
      medicationIds: [own.id, foreign.id],
    },
    "synthetic-chat-ownership-key",
  );
  await domain.processJob(job.id);

  expect(await store.get("jobs", job.id)).toMatchObject({
    status: "failed",
    error: { code: "not_found" },
  });
  expect(await store.list("chats")).toEqual([]);
  expect(await store.list("generated")).toEqual([]);
  expect(json).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
