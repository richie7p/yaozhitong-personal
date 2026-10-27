import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Domain } from "../server/domain";
import { tick, type Sender } from "../server/scheduler";
import { MemoryStore, type Doc, type Tx } from "../server/store";
import type { Schedule } from "../shared/schema";

const BEFORE = "2026-10-19T23:59:00.000Z";
const DUE = "2026-10-20T00:00:00.000Z";
const FAMILY_DUE = "2026-10-20T01:00:00.000Z";
const medInput = {
  name: "合成排程測試品",
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
  confirmed: true,
};

type Read = {
  kind: "get" | "transaction" | "list" | "due";
  collection: string;
  returned: number;
  where?: [string, unknown];
};

/** Counts document reads, including transaction reads and empty-query minimums. */
class CountingStore extends MemoryStore {
  reads: Read[] = [];
  resetReads() {
    this.reads = [];
  }
  get billedReads() {
    return this.reads.reduce(
      (sum, read) => sum + Math.max(1, read.returned),
      0,
    );
  }
  override async get<T = Doc>(
    collection: string,
    id: string,
  ): Promise<T | null> {
    const value = await super.get<T>(collection, id);
    this.reads.push({ kind: "get", collection, returned: value ? 1 : 0 });
    return value;
  }
  override async list<T = Doc>(
    collection: string,
    where?: [string, unknown],
    and?: [string, unknown],
  ): Promise<T[]> {
    const rows = await super.list<T>(collection, where, and);
    this.reads.push({ kind: "list", collection, returned: rows.length, where });
    return rows;
  }
  override async queryDue<T = Doc>(
    collection: string,
    field: string,
    cutoff: string | number,
    where?: [string, unknown],
  ): Promise<T[]> {
    const rows = await super.queryDue<T>(collection, field, cutoff, where);
    this.reads.push({ kind: "due", collection, returned: rows.length, where });
    return rows;
  }
  override transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return super.transaction((tx) =>
      fn({
        ...tx,
        get: async <U = Doc>(collection: string, id: string) => {
          const value = await tx.get<U>(collection, id);
          this.reads.push({
            kind: "transaction",
            collection,
            returned: value ? 1 : 0,
          });
          return value;
        },
      }),
    );
  }
}

async function addUser(d: Domain, uid: string) {
  return d.account({
    uid,
    email: `${uid}@example.test`,
    name: uid,
    verified: true,
    admin: false,
  });
}

async function setup(
  options: {
    family?: boolean;
    relationship?: boolean;
    times?: string[];
    startDate?: string;
    endDate?: string | null;
    legacy?: boolean;
  } = {},
) {
  const store = new CountingStore();
  const d = new Domain(store);
  await addUser(d, "owner");
  await addUser(d, "caregiver");
  await d.profile("owner", {
    displayName: "合成測試者",
    notifyFamily: options.family ?? true,
  });
  let relationshipId: string | undefined;
  if (options.relationship !== false) {
    const invite = await d.invite("owner", true);
    relationshipId = (await d.accept("caregiver", invite.code, true)).id;
  }
  const med = await d.saveMedication("owner", medInput);
  const schedule = await d.saveSchedule("owner", {
    medicationId: med.id,
    times: options.times || ["08:00"],
    startDate: options.startDate || "2026-10-20",
    endDate: options.endDate ?? null,
  });
  if (options.legacy) {
    const legacy: any = { ...schedule };
    delete legacy.nextFamilyAt;
    delete legacy.reminderSchemaVersion;
    await store.set("schedules", schedule.id, legacy);
  }
  const sends: Array<{ uid: string; id: string }> = [];
  const sender: Sender = async (uid, id) => {
    sends.push({ uid, id });
  };
  const run = async (at: string, send = sender, domain = d) => {
    vi.setSystemTime(new Date(at));
    return tick(domain, new Date(at), send);
  };
  return { d, store, med, schedule, relationshipId, sends, sender, run };
}

async function notifications(store: MemoryStore, family: boolean) {
  return (await store.list("notifications")).filter(
    (n) => Boolean(n.relationshipId) === family,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(BEFORE));
});
afterEach(() => vi.useRealTimers());

describe("indexed medication reminders", () => {
  it("does not send early and delivers once at the minute boundary despite concurrent/repeated ticks", async () => {
    const { d, store, run, sender, sends, schedule } = await setup();
    await run("2026-10-19T23:59:59.999Z");
    expect(sends).toHaveLength(0);
    vi.setSystemTime(new Date(DUE));
    await Promise.all([
      tick(d, new Date(DUE), sender),
      tick(d, new Date(DUE), sender),
      tick(d, new Date(DUE), sender),
    ]);
    await run("2026-10-20T00:00:59.000Z");
    expect(sends).toHaveLength(1);
    expect(sends[0].uid).toBe("owner");
    expect((await store.get<Schedule>("schedules", schedule.id))?.nextAt).toBe(
      "2026-10-21T00:00:00.000Z",
    );
  });

  it("checks the family exactly one hour after the dose and deduplicates repeated ticks", async () => {
    const { d, run, sends, store, sender } = await setup();
    await run(DUE);
    await run("2026-10-20T00:59:59.999Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    vi.setSystemTime(new Date(FAMILY_DUE));
    await Promise.all([
      tick(d, new Date(FAMILY_DUE), sender),
      tick(d, new Date(FAMILY_DUE), sender),
    ]);
    await run("2026-10-20T01:00:40.000Z");
    await run("2026-10-20T01:01:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
    expect(await notifications(store, true)).toHaveLength(1);
  });

  it("keeps the final dose's family checkpoint when there is no next owner reminder", async () => {
    const { run, store, schedule, sends } = await setup({
      endDate: "2026-10-20",
    });
    await run(DUE);
    const ended = await store.get<Schedule>("schedules", schedule.id);
    expect(ended?.nextAt).toBeNull();
    expect(ended?.nextFamilyAt).toBe(FAMILY_DUE);
    await run(FAMILY_DUE);
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
    expect(
      (await store.get<Schedule>("schedules", schedule.id))?.nextFamilyAt,
    ).toBeNull();
  });

  it("delivers an ended schedule's final family reminder after Taipei midnight", async () => {
    const { run, sends, store } = await setup({
      times: ["23:30"],
      endDate: "2026-10-20",
    });
    await run("2026-10-20T15:30:00.000Z");
    await run("2026-10-20T16:29:59.999Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    await run("2026-10-20T16:30:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
    expect((await notifications(store, true))[0].dueAt).toBe(
      "2026-10-20T15:30:00.000Z",
    );
  });

  it.each(["taken", "skipped"] as const)(
    "suppresses owner and family delivery when the occurrence is already %s",
    async (status) => {
      const { d, med, run, sends } = await setup();
      await d.doseLog("owner", { medicationId: med.id, dueAt: DUE, status });
      await run(DUE);
      await run(FAMILY_DUE);
      expect(sends).toHaveLength(0);
    },
  );

  it("does not replay owner reminders more than one hour late after an outage", async () => {
    const { run, sends, store, schedule } = await setup({ family: false });
    await run("2026-10-20T02:00:00.000Z");
    expect(sends).toHaveLength(0);
    expect((await store.get<Schedule>("schedules", schedule.id))?.nextAt).toBe(
      "2026-10-21T00:00:00.000Z",
    );
  });

  it("still delivers a recent dose after an outage when an earlier dose in the same schedule is stale", async () => {
    const { run, sends, store } = await setup({
      family: false,
      times: ["08:00", "08:30"],
    });
    await run("2026-10-20T01:15:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    const owner = await notifications(store, false);
    expect(owner).toHaveLength(1);
    expect(owner[0].dueAt).toBe("2026-10-20T00:30:00.000Z");
  });

  it("bounds outage family catch-up to recent occurrences instead of replaying all historic doses", async () => {
    vi.setSystemTime(new Date("2026-10-17T23:59:00.000Z"));
    const { run, sends, store } = await setup({ startDate: "2026-10-18" });
    await run("2026-10-20T01:01:00.000Z");
    expect(sends.every((s) => s.uid === "caregiver")).toBe(true);
    const family = await notifications(store, true);
    expect(family.some((n) => n.dueAt === DUE)).toBe(true);
    expect(family.every((n) => n.dueAt >= "2026-10-19T00:00:00.000Z")).toBe(
      true,
    );
    expect(family.length).toBeLessThanOrEqual(2);
  });
});

describe("family permission changes and pending delivery", () => {
  it("rechecks today's overdue dose after family reminders are enabled, even across a restart", async () => {
    const { d, run, sends, store, sender } = await setup({ family: false });
    await run(DUE);
    await run(FAMILY_DUE);
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    vi.setSystemTime(new Date("2026-10-20T01:30:00.000Z"));
    await d.profile("owner", { displayName: "合成測試者", notifyFamily: true });
    const restartedStore = new CountingStore();
    restartedStore.data = structuredClone(store.data);
    await run("2026-10-20T01:30:00.000Z", sender, new Domain(restartedStore));
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
  });

  it("rechecks today's overdue dose when a family invitation is accepted later", async () => {
    const { d, run, sends } = await setup({ relationship: false });
    await run(DUE);
    await run(FAMILY_DUE);
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    vi.setSystemTime(new Date("2026-10-20T01:30:00.000Z"));
    const invite = await d.invite("owner", true);
    await d.accept("caregiver", invite.code, true);
    await run("2026-10-20T01:30:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
  });

  it("rechecks a newly saved schedule's already-overdue dose today", async () => {
    const { d, run, med, sends } = await setup({ times: ["10:00"] });
    await run(FAMILY_DUE);
    vi.setSystemTime(new Date("2026-10-20T01:30:00.000Z"));
    await d.saveSchedule("owner", {
      medicationId: med.id,
      times: ["08:00"],
      startDate: "2026-10-20",
    });
    await run("2026-10-20T01:30:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["caregiver"]);
  });

  it("rearms family checks after an owner account is re-enabled", async () => {
    const { d, run, sends } = await setup();
    await run(DUE);
    await d.setUser("admin", "owner", { disabled: true });
    await run(FAMILY_DUE);
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    vi.setSystemTime(new Date("2026-10-20T01:30:00.000Z"));
    await d.setUser("admin", "owner", { disabled: false });
    await run("2026-10-20T01:30:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
  });

  it.each([
    "consent removed",
    "relationship revoked",
    "medication revised",
    "schedule changed",
    "owner disabled",
    "caregiver disabled",
    "dose taken",
    "dose skipped",
  ])(
    "revalidates %s before retrying a failed family delivery",
    async (change) => {
      const { d, run, store, med, relationshipId, sends } = await setup();
      await run(DUE);
      let attempts = 0;
      await run(FAMILY_DUE, async () => {
        attempts++;
        throw Error("synthetic sender outage");
      });
      expect(attempts).toBe(1);
      switch (change) {
        case "consent removed":
          await d.profile("owner", {
            displayName: "合成測試者",
            notifyFamily: false,
          });
          break;
        case "relationship revoked":
          await d.revoke("owner", relationshipId!);
          break;
        case "medication revised":
          await d.saveMedication(
            "owner",
            { ...medInput, name: "已修訂測試品" },
            med.id,
          );
          break;
        case "schedule changed":
          await d.saveSchedule("owner", {
            medicationId: med.id,
            times: ["10:00"],
            startDate: "2026-10-20",
          });
          break;
        case "owner disabled":
        case "caregiver disabled": {
          const uid = change === "owner disabled" ? "owner" : "caregiver";
          await d.setUser("admin", uid, { disabled: true });
          break;
        }
        case "dose taken":
        case "dose skipped":
          await d.doseLog("owner", {
            medicationId: med.id,
            dueAt: DUE,
            status: change === "dose taken" ? "taken" : "skipped",
          });
      }
      await run("2026-10-20T01:01:00.000Z");
      expect(sends.map((s) => s.uid)).toEqual(["owner"]);
      expect(
        (await notifications(store, true)).every(
          (n) => n.status === "cancelled",
        ),
      ).toBe(true);
    },
  );

  it("retries a sender outage after its lease, including after process restart, without duplicate delivery", async () => {
    const { run, store, sender, sends } = await setup({ family: false });
    let failures = 0;
    await run(DUE, async () => {
      failures++;
      throw Error("synthetic network outage");
    });
    expect(failures).toBe(1);
    const restartedStore = new CountingStore();
    restartedStore.data = structuredClone(store.data);
    const restarted = new Domain(restartedStore);
    await run("2026-10-20T00:00:59.999Z", sender, restarted);
    expect(sends).toHaveLength(0);
    vi.setSystemTime(new Date("2026-10-20T00:01:00.000Z"));
    await Promise.all([
      tick(restarted, new Date(), sender),
      tick(restarted, new Date(), sender),
    ]);
    await run("2026-10-20T00:02:00.000Z", sender, restarted);
    expect(sends).toHaveLength(1);
    const records = await notifications(restartedStore, false);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("sent");
  });
});

describe("migration and reminder read budget", () => {
  it("resumes a migration left by a crashed process after its durable lease expires", async () => {
    const { store, run, sends, schedule } = await setup({ legacy: true });
    await store.set("settings", "reminder-due-v1", {
      token: "crashed-process",
      leaseUntil: Date.parse("2026-10-20T00:04:00.000Z"),
    });
    await run(DUE);
    expect(sends).toHaveLength(0);
    expect(
      (await store.get<Schedule>("schedules", schedule.id))
        ?.reminderSchemaVersion,
    ).toBeUndefined();
    await run("2026-10-20T00:04:00.000Z");
    expect((await store.get("settings", "reminder-due-v1"))?.ready).toBe(true);
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    await run(FAMILY_DUE);
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
  });

  it("migrates older schedules once and preserves reminders across a cold start without another full scan", async () => {
    const { d, store, run, sender, sends, schedule } = await setup({
      legacy: true,
    });
    store.resetReads();
    await run(BEFORE);
    expect(
      store.reads.some(
        (r) => r.kind === "list" && r.collection === "schedules",
      ),
    ).toBe(true);
    const migrated = await store.get<Schedule>("schedules", schedule.id);
    expect(migrated?.reminderSchemaVersion).toBe(1);
    expect(migrated?.nextAt).toBe(DUE);
    expect(migrated?.nextFamilyAt).toBe(FAMILY_DUE);
    expect(await store.get("settings", "reminder-due-v1")).not.toBeNull();

    store.resetReads();
    await run("2026-10-19T23:59:10.000Z", sender, new Domain(store));
    expect(
      store.reads.filter(
        (r) => r.kind === "list" && r.collection === "schedules",
      ),
    ).toHaveLength(0);

    const restartedStore = new CountingStore();
    restartedStore.data = structuredClone(store.data);
    const restarted = new Domain(restartedStore);
    await run("2026-10-19T23:59:20.000Z", sender, restarted);
    expect(
      restartedStore.reads.filter(
        (r) => r.kind === "list" && r.collection === "schedules",
      ),
    ).toHaveLength(0);
    await run(DUE, sender, restarted);
    await run(FAMILY_DUE, sender, restarted);
    expect(sends.map((s) => s.uid)).toEqual(["owner", "caregiver"]);
    expect(d.store).toBe(store);
  });

  it("recovers a legacy ended schedule's final family check after midnight", async () => {
    const { store, schedule, run, sends } = await setup({
      legacy: true,
      times: ["23:30"],
      endDate: "2026-10-20",
    });
    await store.set("schedules", schedule.id, {
      ...store.data.schedules[schedule.id],
      nextAt: null,
    });
    await run("2026-10-20T16:30:00.000Z");
    expect(sends.map((s) => s.uid)).toEqual(["caregiver"]);
  });

  it("keeps idle read cost fixed for 50 users with three future schedules each", async () => {
    const measure = async (users: number, schedulesPerUser: number) => {
      const store = new CountingStore();
      const d = new Domain(store);
      for (let user = 0; user < users; user++) {
        const uid = `cost-${user}`;
        await addUser(d, uid);
        await d.profile(uid, { displayName: uid, notifyFamily: true });
        for (let index = 0; index < schedulesPerUser; index++) {
          const med = await d.saveMedication(uid, {
            ...medInput,
            name: `${uid}-${index}`,
          });
          await d.saveSchedule(uid, {
            medicationId: med.id,
            times: ["10:00"],
            startDate: "2026-10-20",
          });
        }
      }
      const noSend = async () => {
        throw Error("future reminders must not send");
      };
      await tick(d, new Date(BEFORE), noSend);
      store.resetReads();
      await tick(d, new Date("2026-10-20T00:01:00.000Z"), noSend);
      const warm = { reads: store.billedReads, calls: [...store.reads] };
      const cold = new CountingStore();
      cold.data = structuredClone(store.data);
      await tick(
        new Domain(cold),
        new Date("2026-10-20T00:02:00.000Z"),
        noSend,
      );
      return {
        warm,
        cold: { reads: cold.billedReads, calls: [...cold.reads] },
      };
    };
    const small = await measure(1, 1);
    const large = await measure(50, 3);
    expect(large.warm.reads).toBe(small.warm.reads);
    expect(large.cold.reads).toBe(small.cold.reads);
    expect(large.warm.reads).toBeLessThan(20);
    expect(large.cold.reads).toBeLessThan(20);
    for (const result of [small, large])
      for (const phase of [result.warm, result.cold]) {
        expect(
          phase.calls.filter(
            (r) => r.kind === "due" && r.collection === "schedules",
          ),
        ).toHaveLength(2);
        expect(
          phase.calls.filter(
            (r) =>
              r.kind === "list" &&
              [
                "schedules",
                "medications",
                "profiles",
                "relationships",
                "doseLogs",
              ].includes(r.collection),
          ),
        ).toHaveLength(0);
        expect(
          phase.calls.filter((r) =>
            [
              "users",
              "medications",
              "profiles",
              "relationships",
              "doseLogs",
            ].includes(r.collection),
          ),
        ).toHaveLength(0);
      }
  });
});
