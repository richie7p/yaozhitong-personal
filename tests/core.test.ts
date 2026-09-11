import { describe, it, expect } from "vitest";
import { MemoryStore } from "../server/store";
import { Domain, hash, nextTime } from "../server/domain";
import { createApp } from "../server/app";
import {
  citationsValid,
  grounded,
  RecognitionSchema,
  selectChunks,
  type Llm,
} from "../server/ai";
import { scoreDrug } from "../server/catalog";
import { tick } from "../server/scheduler";
import {
  MedicationSchema,
  type Chunk,
  type Drug,
  type Identity,
  type Schedule,
  type Job,
} from "../shared/schema";
const identities: Record<string, Identity> = {
  a: {
    uid: "a",
    email: "a@example.test",
    name: "A",
    verified: true,
    admin: false,
  },
  b: {
    uid: "b",
    email: "b@example.test",
    name: "B",
    verified: true,
    admin: false,
  },
  admin: {
    uid: "admin",
    email: "admin@example.test",
    name: "Admin",
    verified: true,
    admin: true,
  },
  unverified: {
    uid: "unverified",
    email: "u@example.test",
    name: "U",
    verified: false,
    admin: false,
  },
};
const drug: Drug = {
  licenseNo: "TEST-LICENSE",
  nameZh: "測試品 5mg",
  nameEn: "Fixture 5mg",
  strength: "5mg",
  form: "錠",
  ingredients: ["fixture-ingredient"],
  revoked: false,
};
const chunk: Chunk = {
  id: "chunk-a",
  licenseNo: drug.licenseNo,
  version: "v1",
  page: 1,
  start: 0,
  text: "這是一份合成測試資料，僅供程式驗證，不可作為用藥依據。",
};
const good = {
  text: "這是合成測試資料。",
  citations: [
    { chunkId: chunk.id, quote: "這是一份合成測試資料，僅供程式驗證" },
  ],
};
const medInput = {
  name: drug.nameZh,
  licenseNo: null,
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
  confirmed: true,
};
async function setup(
  llm: Llm = {
    json: async () => ({
      status: "supported",
      claims: [good],
      quiz: [],
      followups: [],
    }),
  },
) {
  const store = new MemoryStore();
  const d = new Domain(store, undefined, () => llm);
  d.catalog.get = async (lic) => (lic === drug.licenseNo ? drug : null);
  d.catalog.all = async () => [drug];
  for (const p of Object.values(identities)) await d.account(p);
  const app = createApp(d, async (token) => {
    if (!identities[token]) throw Error("unauthenticated");
    return identities[token];
  });
  const req = (
    path: string,
    method = "GET",
    body?: any,
    user = "a",
    headers = {},
  ) =>
    app.request("/api/v1" + path, {
      method,
      headers: {
        authorization: "Bearer " + user,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { d, store, app, req };
}
describe("account and access boundaries", () => {
  it("starts new users with no health data", async () => {
    const { req } = await setup();
    expect((await (await req("/medications")).json()).items).toEqual([]);
    expect((await (await req("/me")).json()).profile).toBeNull();
  });
  it("isolates medications, jobs and profile data", async () => {
    const { d, req } = await setup();
    const m = await d.saveMedication("a", medInput);
    expect(
      (await req("/medications/" + m.id, "PUT", medInput, "b")).status,
    ).toBe(404);
    expect(
      (await (await req("/medications", "GET", undefined, "b")).json()).items,
    ).toEqual([]);
    const j = await d.enqueueJob(
      "a",
      true,
      "bundle",
      { medicationIds: [m.id] },
      "request-key-001",
    );
    expect((await req("/jobs/" + j.id, "GET", undefined, "b")).status).toBe(
      404,
    );
  });
  it("blocks administrator endpoints and privilege escalation", async () => {
    const { req } = await setup();
    expect((await req("/admin/users")).status).toBe(403);
    expect(
      (await req("/admin/users/a", "PATCH", { admin: true }, "admin")).status,
    ).toBe(400);
  });
  it("blocks disabled accounts on existing sessions", async () => {
    const { d, req } = await setup();
    await d.setUser("admin", "a", { disabled: true });
    expect((await req("/me")).status).toBe(403);
  });
  it("requires verified emails and tester eligibility for AI", async () => {
    const { d, req } = await setup();
    expect((await req("/care/invites", "POST", {}, "unverified")).status).toBe(
      403,
    );
    await d.setUser("admin", "a", { eligible: false });
    await expect(
      d.enqueueJob("a", true, "chat", {}, "request-key-001"),
    ).rejects.toMatchObject({ code: "not_eligible" });
  });
  it("only exposes approved caregiver data and revokes immediately", async () => {
    const { d, req } = await setup();
    await d.profile("a", {
      displayName: "A",
      allergies: "SECRET",
      notes: "PRIVATE",
    });
    await d.saveMedication("a", medInput);
    const { code } = await d.invite("a", true);
    const r = await d.accept("b", code, true);
    const snap = await d.snapshot("b", "a");
    expect(JSON.stringify(snap)).not.toMatch(/SECRET|PRIVATE/);
    await expect(d.accept("admin", code, true)).rejects.toMatchObject({
      code: "invalid_invite",
    });
    expect((await req("/medications", "POST", medInput, "b")).status).toBe(201);
    await d.revoke("a", r.id);
    await expect(d.snapshot("b", "a")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("rejects expired invitations", async () => {
    const { d, store } = await setup();
    const { code } = await d.invite("a", true);
    const inv = (await store.get("invites", hash(code)))!;
    await store.set("invites", inv.id, { ...inv, expiresAt: 0 });
    await expect(d.accept("b", code, true)).rejects.toMatchObject({
      code: "invalid_invite",
    });
  });
  it("admin account listing contains no health profile", async () => {
    const { d, req } = await setup();
    await d.profile("a", { displayName: "A", notes: "PRIVATE HEALTH" });
    const response = await req("/admin/users", "GET", undefined, "admin");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("PRIVATE HEALTH");
  });
});
describe("medication and schedule behavior", () => {
  it("preserves unknown dose and rejects false confirmation", () => {
    expect(MedicationSchema.parse({ name: "Unknown" }).doseAmount).toBeNull();
    expect(() =>
      MedicationSchema.parse({ name: "Unknown", confirmed: true }),
    ).toThrow();
  });
  it("ranks matching strength/form over mismatches", () => {
    expect(scoreDrug(drug, "測試品", "5mg", "錠")).toBeGreaterThan(
      scoreDrug(
        { ...drug, strength: "10mg", form: "糖漿" },
        "測試品",
        "5mg",
        "錠",
      ),
    );
  });
  it("preserves recognition nulls and rejects negative doses", () => {
    const r = {
      status: "succeeded",
      medications: [
        {
          name: "測試",
          doseAmount: null,
          doseUnit: null,
          frequencyRaw: null,
          route: null,
          durationDays: null,
          rawText: "測試",
          confidence: "low",
        },
      ],
    };
    expect(RecognitionSchema.parse(r).medications[0].frequencyRaw).toBeNull();
    expect(
      RecognitionSchema.safeParse({
        ...r,
        medications: [{ ...r.medications[0], doseAmount: -1 }],
      }).success,
    ).toBe(false);
  });
  it("computes timezone-aware times and honors end dates", () => {
    const s = {
      startDate: "2026-09-09",
      endDate: "2026-09-09",
      times: ["08:00", "20:00"],
      timezone: "Asia/Taipei" as const,
    };
    expect(nextTime(s, "2026-09-09T01:00:00.000Z")).toBe(
      "2026-09-09T12:00:00.000Z",
    );
    expect(nextTime(s, "2026-09-09T13:00:00.000Z")).toBeNull();
  });
  it("allows schedules before quiz completion and invalidates only edited medication", async () => {
    const { d, store } = await setup();
    const a = await d.saveMedication("a", medInput),
      b = await d.saveMedication("a", { ...medInput, name: "Other" });
    const input = { times: ["08:00"], startDate: "2026-09-09", endDate: null };
    const sa = await d.saveSchedule("a", { ...input, medicationId: a.id }),
      sb = await d.saveSchedule("a", { ...input, medicationId: b.id });
    await d.saveMedication("a", { ...medInput, doseAmount: 2 }, a.id);
    expect((await store.get("schedules", sa.id))?.active).toBe(false);
    expect((await store.get("schedules", sb.id))?.active).toBe(true);
  });
  it("rejects schedules for unconfirmed and PRN medication", async () => {
    const { d } = await setup();
    const draft = await d.saveMedication("a", { name: "draft" }),
      prn = await d.saveMedication("a", { ...medInput, prn: true });
    for (const m of [draft, prn])
      await expect(
        d.saveSchedule("a", {
          medicationId: m.id,
          times: ["08:00"],
          startDate: "2026-09-09",
        }),
      ).rejects.toMatchObject({ code: "unconfirmed_usage" });
  });
  it("keeps historical logs after drug removal and permits correction", async () => {
    const { d, store, req } = await setup();
    const m = await d.saveMedication("a", { ...medInput, prn: true });
    const log = await d.doseLog("a", {
      medicationId: m.id,
      dueAt: null,
      status: "taken",
      operationId: crypto.randomUUID(),
    });
    await d.removeMedication("a", m.id);
    expect(await store.get("doseLogs", log.id)).not.toBeNull();
    expect(
      (await req("/dose-logs/" + log.id, "PATCH", { status: "skipped" }))
        .status,
    ).toBe(200);
    expect((await store.list("doseCorrections")).length).toBe(1);
  });
  it("deduplicates a repeated PRN operation", async () => {
    const { d, store } = await setup();
    const m = await d.saveMedication("a", { ...medInput, prn: true });
    const input = {
      medicationId: m.id,
      dueAt: null,
      status: "taken",
      operationId: crypto.randomUUID(),
    };
    await Promise.all([d.doseLog("a", input), d.doseLog("a", input)]);
    expect((await store.list("doseLogs")).length).toBe(1);
  });
});
describe("grounding and jobs", () => {
  it("retrieves Chinese topic terms within longer questions", () => {
    const irrelevant = {
      ...chunk,
      id: "early",
      text: "包裝廠商與來源資訊。".repeat(8),
    };
    const relevant = {
      ...chunk,
      id: "late",
      text: "儲藏條件為測試段落，不是醫療資料。",
    };
    expect(
      selectChunks([irrelevant, relevant], "請說明此文件的儲藏條件", 60)[0].id,
    ).toBe("late");
  });
  it("rejects invented and wrong-source citations", () => {
    expect(citationsValid(good, [chunk])).toBe(true);
    expect(
      citationsValid(
        {
          ...good,
          citations: [{ chunkId: "other", quote: good.citations[0].quote }],
        },
        [chunk],
      ),
    ).toBe(false);
    expect(
      citationsValid(
        {
          ...good,
          citations: [{ chunkId: chunk.id, quote: "這是一段完全捏造的文字" }],
        },
        [chunk],
      ),
    ).toBe(false);
  });
  it("rejects a semantically unsupported claim even when the quote exists", async () => {
    let calls = 0;
    const llm = {
      json: async () =>
        ++calls === 1
          ? {
              status: "supported",
              claims: [{ ...good, text: "因此可以自行增加劑量。" }],
            }
          : { supported: [false] },
    };
    const r = await grounded(llm, "測試", [chunk], {}, "chat");
    expect(r.claims).toEqual([]);
    expect(r.rejectedCount).toBe(1);
    expect(r.status).toBe("insufficient_data");
  });
  it("fails closed on malformed semantic verification", async () => {
    let calls = 0;
    const llm = {
      json: async () =>
        ++calls === 1
          ? { status: "supported", claims: [good] }
          : { supported: [] },
    };
    await expect(
      grounded(llm, "測試", [chunk], {}, "chat"),
    ).rejects.toMatchObject({ code: "verification_failed" });
  });
  it("does not call AI without source material", async () => {
    let calls = 0;
    const r = await grounded(
      {
        json: async () => {
          calls++;
        },
      },
      "test",
      [],
      {},
      "chat",
    );
    expect(r.status).toBe("insufficient_data");
    expect(calls).toBe(0);
  });
  it("deduplicates concurrent requests and detects key reuse with different input", async () => {
    const { d, store } = await setup();
    const j = await Promise.all(
      Array.from({ length: 5 }, () =>
        d.enqueueJob("a", true, "chat", { question: "q" }, "request-key-001"),
      ),
    );
    expect(new Set(j.map((x) => x.id)).size).toBe(1);
    expect((await store.list("usage")).every((x) => x.count === 1)).toBe(true);
    await expect(
      d.enqueueJob("a", true, "chat", { question: "other" }, "request-key-001"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("enforces quota atomically", async () => {
    const { d, store } = await setup();
    const result = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        d.enqueueJob(
          "a",
          true,
          "chat",
          { question: "q" },
          "request-key-" + i.toString().padStart(3, "0"),
        ),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect((await store.list("jobs")).length).toBe(20);
  });
  it("isolates personalized caches and invalidates corrected source versions", async () => {
    let generation = 0;
    const llm = {
      json: async (system: string) =>
        system.includes("審核器")
          ? { supported: [true] }
          : (generation++, { status: "supported", claims: [good] }),
    };
    const { d, store } = await setup(llm);
    await store.set("leaflets", "l", {
      id: "l",
      licenseNo: drug.licenseNo,
      version: "v1",
      sha256: "hash",
      status: "published",
      chunks: [chunk],
    });
    await store.set("published", hash(drug.licenseNo), { leafletId: "l" });
    for (const uid of ["a", "b"]) {
      const m = await d.saveMedication(uid, {
        ...medInput,
        licenseNo: drug.licenseNo,
      });
      const j = await d.enqueueJob(
        uid,
        true,
        "bundle",
        { medicationIds: [m.id] },
        "request-key-001",
      );
      await d.processJob(j.id);
    }
    expect(generation).toBe(2);
    expect((await store.list("generated")).length).toBe(2);
    const m = (await d.medications("a"))[0];
    const l = await store.get("leaflets", "l");
    await store.set("leaflets", "l", { ...l, version: "v2" });
    const j = await d.enqueueJob(
      "a",
      true,
      "bundle",
      { medicationIds: [m.id] },
      "request-key-002",
    );
    await d.processJob(j.id);
    expect(generation).toBe(3);
  });
});
describe("notification delivery and deletion", () => {
  it("sends only once for repeated scheduler ticks and suppresses revoked family notifications", async () => {
    const { d, store } = await setup();
    const m = await d.saveMedication("a", medInput);
    const s: Schedule = {
      id: "s",
      ownerId: "a",
      medicationId: m.id,
      medicationRevision: m.revision,
      active: true,
      times: ["08:00"],
      startDate: "2026-09-09",
      endDate: null,
      timezone: "Asia/Taipei",
      nextAt: "2026-09-09T00:00:00.000Z",
    };
    await store.set("schedules", "s", s);
    const sends: string[] = [];
    const sender = async (uid: string, id: string) => {
      sends.push(uid + id);
    };
    await tick(d, new Date("2026-09-09T00:00:20Z"), sender);
    await tick(d, new Date("2026-09-09T00:00:40Z"), sender);
    expect(sends).toHaveLength(1);
    const invite = await d.invite("a", true);
    const r = await d.accept("b", invite.code, true);
    await store.set("notifications", "family", {
      id: "family",
      ownerId: "b",
      recipientId: "a",
      medicationId: m.id,
      medicationRevision: m.revision,
      relationshipId: r.id,
      occurrenceId: "occurrence",
      status: "pending",
      leaseUntil: 0,
    });
    await d.revoke("a", r.id);
    await tick(d, new Date("2026-09-09T01:00:00Z"), sender);
    expect(sends).toHaveLength(1);
    expect((await store.get("notifications", "family"))?.status).toBe(
      "cancelled",
    );
  });
  it("deactivates account immediately and removes private records", async () => {
    const { d, store, req } = await setup();
    await d.saveMedication("a", medInput);
    await d.profile("a", { displayName: "A", notes: "secret" });
    await d.deleteAccount("a");
    expect((await req("/me")).status).toBe(403);
    await d.processJob("delete-" + hash("a"));
    expect(await store.get("profiles", "a")).toBeNull();
    expect(await store.list("medications", ["ownerId", "a"])).toEqual([]);
  });
});

describe("revision and concurrent operation regressions", () => {
  it("retains unknown recognition text and normalizes only missing text fields", () => {
    const r = MedicationSchema.parse({
      name: "手動草稿",
      rawText: "藥名可讀；劑量缺漏",
      durationDays: null,
    });
    expect(r.rawText).toContain("劑量缺漏");
    expect(r.doseAmount).toBeNull();
  });
  it("removes a corrected dose audit record on account deletion", async () => {
    const { d, store } = await setup();
    const m = await d.saveMedication("a", { ...medInput, prn: true });
    const b = {
      medicationId: m.id,
      dueAt: null,
      status: "taken",
      operationId: crypto.randomUUID(),
    };
    await d.doseLog("a", b);
    await d.doseLog("a", { ...b, status: "skipped" });
    const correction = (await store.list("doseCorrections"))[0];
    expect(await store.get("doseCorrections", correction.id)).not.toBeNull();
    await d.deleteAccount("a");
    await d.processJob("delete-" + hash("a"));
    expect(await store.list("doseCorrections")).toEqual([]);
    await expect(d.saveMedication("a", medInput)).rejects.toMatchObject({
      code: "account_disabled",
    });
  });
  it("reserves at most 50 tester seats concurrently", async () => {
    const { d, store } = await setup();
    for (let i = 0; i < 52; i++) {
      const id = "tester" + i;
      await d.account({ ...identities.a, uid: id });
      await store.set("users", id, {
        ...(await store.get("users", id)),
        eligible: false,
      });
    }
    const results = await Promise.allSettled(
      Array.from({ length: 52 }, (_, i) =>
        d.setUser("admin", "tester" + i, { eligible: true }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(50);
    expect((await store.get("settings", "testerSeats"))?.uids).toHaveLength(50);
  });
  it("deduplicates concurrent retries before the worker claims them", async () => {
    const { d, store } = await setup();
    const j = await d.enqueueJob(
      "a",
      true,
      "chat",
      { question: "q" },
      "retry-request-001",
    );
    await store.set("jobs", j.id, { ...j, status: "failed", attempts: 1 });
    await Promise.all([d.retryJob("a", j.id), d.retryJob("a", j.id)]);
    expect((await store.get("jobs", j.id))?.status).toBe("queued");
    expect((await store.list("usage")).every((u) => u.count === 1)).toBe(true);
  });
  it("hides stale learning and rejects old answers after source publication changes", async () => {
    const { d, store, req } = await setup();
    const m = await d.saveMedication("a", medInput);
    const row = {
      id: "learn",
      ownerId: "a",
      medicationRevisions: [{ id: m.id, revision: m.revision }],
      profileVersion: 0,
      result: { sourceVersions: { [drug.licenseNo]: "v1" }, quiz: [] },
    };
    await store.set("leaflets", "l", { version: "v2" });
    await store.set("published", hash(drug.licenseNo), { leafletId: "l" });
    await store.set("learning", "learn", row);
    expect((await (await req("/learning")).json()).items).toEqual([]);
    expect(
      (await req("/learning/learn/answers", "POST", { answers: {} })).status,
    ).toBe(409);
  });
  it("suppresses owner reminders once the occurrence is recorded", async () => {
    const { d, store } = await setup();
    const m = await d.saveMedication("a", medInput);
    const s: Schedule = {
      id: "s",
      ownerId: "a",
      medicationId: m.id,
      medicationRevision: 1,
      active: true,
      times: ["08:00"],
      startDate: "2026-09-09",
      endDate: null,
      timezone: "Asia/Taipei",
      nextAt: "2026-09-09T00:00:00.000Z",
    };
    await store.set("schedules", "s", s);
    const row = (await d.today("a", "2026-09-09"))[0];
    await d.doseLog("a", {
      medicationId: m.id,
      dueAt: row.dueAt,
      status: "taken",
    });
    let sent = 0;
    await tick(d, new Date("2026-09-09T00:00:20Z"), async () => {
      sent++;
    });
    expect(sent).toBe(0);
  });
  it("cancels a pending reminder whose time was removed from its schedule", async () => {
    const { d, store } = await setup();
    const m = await d.saveMedication("a", medInput);
    const s: Schedule = {
      id: "s",
      ownerId: "a",
      medicationId: m.id,
      medicationRevision: 1,
      active: true,
      times: ["08:00"],
      startDate: "2026-09-09",
      endDate: null,
      timezone: "Asia/Taipei",
      nextAt: "2026-09-09T00:00:00.000Z",
    };
    await store.set("schedules", "s", s);
    await tick(d, new Date("2026-09-09T00:00:20Z"), async () => {
      throw Error("offline");
    });
    await store.set("schedules", "s", {
      ...s,
      times: ["09:00"],
      nextAt: "2026-09-09T01:00:00.000Z",
    });
    let sent = 0;
    await tick(d, new Date("2026-09-09T00:02:00Z"), async () => {
      sent++;
    });
    expect(sent).toBe(0);
    expect((await store.list("notifications"))[0].status).toBe("cancelled");
  });
  it("does not recreate AI results if deletion completes while the model is running", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const reached = new Promise<void>((r) => {
      started = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const llm = {
      json: async () => {
        started();
        await hold;
        return { status: "not_found", claims: [] };
      },
    };
    const { d, store } = await setup(llm);
    await store.set("leaflets", "l", {
      id: "l",
      licenseNo: drug.licenseNo,
      version: "v1",
      sha256: "hash",
      status: "published",
      chunks: [chunk],
    });
    await store.set("published", hash(drug.licenseNo), { leafletId: "l" });
    const m = await d.saveMedication("a", {
      ...medInput,
      licenseNo: drug.licenseNo,
    });
    const j = await d.enqueueJob(
      "a",
      true,
      "chat",
      { medicationIds: [m.id], question: "q" },
      "delete-race-001",
    );
    const processing = d.processJob(j.id);
    await reached;
    await d.deleteAccount("a");
    await d.processJob("delete-" + hash("a"));
    release();
    await processing;
    expect(await store.list("generated", ["ownerId", "a"])).toEqual([]);
    expect(await store.list("chats", ["ownerId", "a"])).toEqual([]);
    expect(await store.get("jobs", j.id)).toBeNull();
  });
});
