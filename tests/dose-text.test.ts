import { afterEach, describe, expect, it, vi } from "vitest";
import { MedicationSchema, type Identity } from "../shared/schema";
import { doseLabel } from "../shared/medication";
import { recognize } from "../server/ai";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { tick } from "../server/scheduler";

const literalInput = {
  name: "合成乳膏",
  doseAmount: null,
  doseUnit: "",
  doseText: "適量",
  frequencyRaw: "BID",
  route: "外用",
  confirmed: true,
};
const recognized = {
  name: "合成乳膏",
  strength: "10mg/g",
  form: "乳膏劑",
  doseAmount: null,
  doseUnit: null,
  doseText: "適量",
  frequencyRaw: "BID",
  route: "外用",
  durationDays: null,
  rawText: "合成乳膏10mg/g\n每次用量：適量；頻次：BID；途徑：外用",
  confidence: "high",
};
async function transcribe(overrides: Record<string, unknown> = {}) {
  const result = await recognize(
    {
      json: async () => ({
        status: "succeeded",
        medications: [{ ...recognized, ...overrides }],
      }),
    },
    Buffer.from("synthetic-no-network-image"),
    "image/png",
  );
  return result.medications[0];
}
const identities: Record<string, Identity> = {
  owner: {
    uid: "owner",
    email: "owner@example.test",
    name: "合成測試",
    verified: true,
    admin: false,
  },
  caregiver: {
    uid: "caregiver",
    email: "caregiver@example.test",
    name: "合成家人",
    verified: true,
    admin: false,
  },
};
async function setup() {
  const store = new MemoryStore();
  const domain = new Domain(store, undefined, () => {
    throw Error("Dose transcription/persistence tests must never call AI");
  });
  for (const identity of Object.values(identities))
    await domain.account(identity);
  const app = createApp(domain, async (token) => {
    if (!identities[token]) throw Error("unauthenticated");
    return identities[token];
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    owner = "owner",
  ) =>
    app.request("/api/v1" + path, {
      method,
      headers: {
        authorization: "Bearer " + owner,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { store, domain, request };
}

afterEach(() => vi.useRealTimers());

describe("confirmed literal amounts and older numeric prescriptions", () => {
  it.each(["適量", "薄薄一層"])(
    "accepts a manually confirmed nonnumeric amount: %s",
    (doseText) => {
      const med = MedicationSchema.parse({ ...literalInput, doseText });
      expect(med).toMatchObject({ doseText, doseAmount: null, doseUnit: "" });
      expect(doseLabel(med)).toBe(doseText);
    },
  );
  it("keeps missing amounts null and empty for drafts without inventing one", () => {
    const med = MedicationSchema.parse({ name: "未確認乳膏" });
    expect(med).toMatchObject({
      doseAmount: null,
      doseUnit: "",
      doseText: "",
      confirmed: false,
    });
    expect(doseLabel(med)).toBe("");
  });
  it.each([
    { frequencyRaw: "" },
    { frequencyRaw: "   " },
    { doseText: "" },
    { doseAmount: 1, doseUnit: "錠" },
    { doseAmount: 1 },
    { doseUnit: "錠" },
  ])("rejects incomplete or mixed confirmed amount %#", (overrides) => {
    expect(
      MedicationSchema.safeParse({ ...literalInput, ...overrides }).success,
    ).toBe(false);
  });
  it("allows old numeric medication input and displays its original units", () => {
    const med = MedicationSchema.parse({
      name: "舊版合成錠",
      doseAmount: 0.5,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    });
    expect(med.doseText).toBe("");
    expect(doseLabel(med)).toBe("0.5 錠");
    expect(doseLabel({ doseAmount: 0.5, doseUnit: "錠" })).toBe("0.5 錠");
  });
  it("rejects mixed numeric and text amounts even for an unconfirmed draft", () => {
    expect(
      MedicationSchema.safeParse({
        ...literalInput,
        confirmed: false,
        doseAmount: 1,
        doseUnit: "公克",
      }).success,
    ).toBe(false);
  });
});

describe("literal source boundaries for AI transcription", () => {
  it.each(["適量", "薄薄一層"])(
    "preserves a verbatim nonnumeric dose without numeric defaults: %s",
    async (doseText) => {
      const med = await transcribe({
        doseText,
        rawText:
          "合成乳膏10mg/g\n每次用量：" + doseText + "；頻次：BID；途徑：外用",
      });
      expect(med).toMatchObject({
        doseText,
        doseAmount: null,
        doseUnit: null,
        frequencyRaw: "BID",
      });
    },
  );
  it("does not fill a missing amount from route, heading or a null response", async () => {
    expect(
      await transcribe({
        doseText: null,
        rawText: "合成乳膏10mg/g\n頻次：BID；途徑：外用",
      }),
    ).toMatchObject({ doseText: null, doseAmount: null, doseUnit: null });
  });
  it("clears a model-added literal not present in the transcribed source", async () => {
    expect(
      await transcribe({
        doseText: "薄薄一層",
      }),
    ).toMatchObject({
      doseText: null,
      doseAmount: null,
      doseUnit: null,
      confidence: "low",
    });
  });
  it("rejects text stitched from separate noncontiguous source fields", async () => {
    expect(
      await transcribe({
        doseText: "適量薄薄一層",
        rawText: "合成乳膏10mg/g\n每次用量：適量；備註：薄薄一層；頻次：BID",
      }),
    ).toMatchObject({ doseText: null, confidence: "low" });
  });
  it("does not accept route text as evidence of an otherwise missing dose", async () => {
    expect(
      await transcribe({
        doseText: "外用",
        rawText: "合成乳膏10mg/g\n頻次：BID；途徑：外用",
      }),
    ).toMatchObject({ doseText: null, confidence: "low" });
  });
  it("does not accept product-heading concentration as a literal dose when strength is missing", async () => {
    expect(
      await transcribe({
        strength: null,
        doseText: "10mg/g",
        rawText: "合成乳膏10mg/g\n頻次：BID；途徑：外用",
      }),
    ).toMatchObject({ doseText: null, confidence: "low" });
  });
  it("clears text and numeric fields together when the provider returns both", async () => {
    expect(
      await transcribe({
        doseAmount: 1,
        doseUnit: "公克",
        rawText:
          "合成乳膏10mg/g\n每次用量：適量（1公克）；頻次：BID；途徑：外用",
      }),
    ).toMatchObject({
      doseText: null,
      doseAmount: null,
      doseUnit: null,
      confidence: "low",
    });
  });
  it("retains literal null as unknown instead of a dose label", async () => {
    expect(await transcribe({ doseText: "null" })).toMatchObject({
      doseText: null,
      doseAmount: null,
      doseUnit: null,
    });
  });
});

describe("literal-dose API persistence, reminders and recovery", () => {
  it("preserves text from recognition save through schedule, reminder, log, sharing and export", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T23:59:00.000Z"));
    const { store, request, domain } = await setup();
    const med = await transcribe();
    await store.set("jobs", "literal-recognition", {
      id: "literal-recognition",
      ownerId: "owner",
      kind: "recognition",
      status: "succeeded",
      result: { status: "succeeded", medications: [med] },
    });
    const body = {
      ...literalInput,
      strength: med.strength || "",
      rawText: med.rawText,
      form: med.form || "",
      doseText: med.doseText,
    };
    const save = () =>
      request("/recognitions/literal-recognition/medications/0", "POST", body);
    const response = await save();
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved).toMatchObject({
      doseText: "適量",
      doseAmount: null,
      doseUnit: "",
    });
    expect((await (await save()).json()).id).toBe(saved.id);
    expect(await store.list("medications")).toHaveLength(1);

    const scheduleResponse = await request("/schedules", "POST", {
      medicationId: saved.id,
      times: ["08:00"],
      startDate: "2026-10-20",
      endDate: "2026-10-20",
    });
    expect(scheduleResponse.status).toBe(201);
    expect((await scheduleResponse.json()).nextAt).toBe(
      "2026-10-20T00:00:00.000Z",
    );
    const today = (await (await request("/today")).json()).items;
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({
      doseText: "適量",
      doseAmount: null,
      doseUnit: "",
    });
    expect(doseLabel(today[0])).toBe("適量");
    const sends: string[] = [];
    await tick(
      domain,
      new Date("2026-10-20T00:00:30.000Z"),
      async (uid, _id, message) => {
        sends.push(uid + ":" + message);
      },
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).not.toContain("null");

    const logResponse = await request("/dose-logs", "POST", {
      medicationId: saved.id,
      dueAt: today[0].dueAt,
      status: "taken",
    });
    expect(logResponse.status).toBe(200);
    expect((await (await request("/today")).json()).items[0].log.status).toBe(
      "taken",
    );
    await tick(domain, new Date("2026-10-20T00:00:40.000Z"), async () => {
      throw Error("A recorded occurrence must not notify again");
    });

    await store.set("relationships", hash("owner|caregiver"), {
      ownerId: "owner",
      caregiverId: "caregiver",
      active: true,
    });
    const shared = await (
      await request("/care/owner/snapshot", "GET", undefined, "caregiver")
    ).json();
    expect(shared.medications[0]).toMatchObject({
      doseText: "適量",
      doseAmount: null,
      doseUnit: "",
    });
    expect(shared.today[0].doseText).toBe("適量");
    const exported = await (await request("/me/export")).json();
    expect(exported.medications[0].doseText).toBe("適量");

    const edit = await request("/medications/" + saved.id, "PUT", {
      ...body,
      doseText: "薄薄一層",
    });
    expect(edit.status).toBe(200);
    expect((await store.list("schedules"))[0].active).toBe(false);
    expect(await store.list("doseLogs")).toHaveLength(1);
  });
  it("rejects confirmed missing frequency and mixed amounts before API persistence", async () => {
    const { store, request } = await setup();
    for (const body of [
      { ...literalInput, frequencyRaw: "" },
      { ...literalInput, doseAmount: 1, doseUnit: "公克" },
    ]) {
      expect((await request("/medications", "POST", body)).status).toBe(400);
    }
    expect(await store.list("medications")).toHaveLength(0);
  });
  it("keeps unconfirmed literal amounts and PRN usage ineligible for fixed reminders", async () => {
    const { request } = await setup();
    for (const body of [
      { ...literalInput, confirmed: false },
      { ...literalInput, prn: true },
    ]) {
      const saved = await (await request("/medications", "POST", body)).json();
      const response = await request("/schedules", "POST", {
        medicationId: saved.id,
        times: ["08:00"],
        startDate: "2026-10-20",
      });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("unconfirmed_usage");
    }
  });
  it("resumes an old saved numeric recognition without doseText without duplicating", async () => {
    const { domain, store } = await setup();
    const input = {
      name: "舊版錠",
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    };
    await store.set("jobs", "old-recognition", {
      id: "old-recognition",
      ownerId: "owner",
      kind: "recognition",
      status: "succeeded",
      result: { medications: [{ name: input.name }] },
    });
    const saved = await domain.saveRecognizedMedication(
      "owner",
      "old-recognition",
      0,
      input,
    );
    const old = { ...saved };
    delete old.doseText;
    await store.set("medications", old.id, old);
    const resumed = await new Domain(store).saveRecognizedMedication(
      "owner",
      "old-recognition",
      0,
      input,
    );
    expect(resumed.id).toBe(old.id);
    expect(doseLabel(resumed)).toBe("1 錠");
    expect(await store.list("medications")).toHaveLength(1);
  });
});
