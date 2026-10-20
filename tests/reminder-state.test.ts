import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Domain } from "../server/domain";
import {
  ensureReminderIndex,
  refreshReminders,
} from "../server/reminder-state";
import { tick, type Sender } from "../server/scheduler";
import { MemoryStore, type Doc, type Tx } from "../server/store";
import type { Schedule } from "../shared/schema";

const BEFORE = "2026-10-19T23:59:00.000Z";
const DUE = "2026-10-20T00:00:00.000Z";
const LATER = "2026-10-20T01:30:00.000Z";

type Write = { collection: string; id: string };

/** Enforce Firestore's read-before-write rule, even in local recovery tests. */
class StrictStore extends MemoryStore {
  beforeRead?: (collection: string, id: string) => void;
  afterCommit?: (writes: Write[]) => Promise<void>;

  override async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const writes: Write[] = [];
    const result = await super.transaction(async (tx) => {
      let written = false;
      return fn({
        get: async <U = Doc>(collection: string, id: string) => {
          if (written) throw Error("Firestore transaction read after write");
          this.beforeRead?.(collection, id);
          return tx.get<U>(collection, id);
        },
        set: (collection, id, value) => {
          written = true;
          writes.push({ collection, id });
          tx.set(collection, id, value);
        },
        delete: (collection, id) => {
          written = true;
          writes.push({ collection, id });
          tx.delete(collection, id);
        },
      });
    });
    await this.afterCommit?.(writes);
    return result;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function restored(store: MemoryStore) {
  const restart = new StrictStore();
  restart.data = structuredClone(store.data);
  return restart;
}

async function setup(
  options: { count?: number; family?: boolean; times?: string[] } = {},
) {
  const store = new StrictStore();
  const d = new Domain(store);
  for (const uid of ["owner", "caregiver"])
    await d.account({
      uid,
      email: `${uid}@example.test`,
      name: uid,
      verified: true,
      admin: false,
    });
  await d.profile("owner", {
    displayName: "合成恢復測試者",
    notifyFamily: options.family ?? true,
  });
  const invite = await d.invite("owner", true);
  await d.accept("caregiver", invite.code, true);
  const schedules: Schedule[] = [];
  for (let index = 0; index < (options.count ?? 1); index++) {
    const med = await d.saveMedication("owner", {
      name: `合成恢復測試品 ${index}`,
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    });
    schedules.push(
      await d.saveSchedule("owner", {
        medicationId: med.id,
        times: options.times || ["08:00"],
        startDate: "2026-10-20",
      }),
    );
  }
  const sends: Array<{ uid: string; id: string }> = [];
  const sender: Sender = async (uid, id) => {
    sends.push({ uid, id });
  };
  return { store, d, schedules, sends, sender };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(BEFORE));
});
afterEach(() => vi.useRealTimers());

describe("durable reminder refresh and migration", () => {
  it("preserves a newer consent change arriving while an older refresh is between schedules", async () => {
    const { store, d, schedules } = await setup({ count: 2 });
    for (const s of schedules)
      await store.set("schedules", s.id, { ...s, nextFamilyAt: null });
    const previous = await store.get("reminderRefresh", "owner");
    store.afterCommit = async (writes) => {
      if (
        !writes.some(
          (w) => w.collection === "schedules" && w.id === schedules[0].id,
        )
      )
        return;
      store.afterCommit = undefined;
      await d.profile("owner", {
        displayName: "合成恢復測試者",
        notifyFamily: false,
      });
    };

    await refreshReminders(store, new Date(LATER));
    const newer = await store.get("reminderRefresh", "owner");
    expect(newer).not.toBeNull();
    expect(newer?.version).not.toBe(previous?.version);
    expect(
      (await store.get<Schedule>("schedules", schedules[0].id))?.nextFamilyAt,
    ).not.toBeNull();
    expect(
      (await store.get<Schedule>("schedules", schedules[1].id))?.nextFamilyAt,
    ).toBeNull();

    await refreshReminders(store, new Date(LATER));
    expect(await store.get("reminderRefresh", "owner")).toBeNull();
    for (const s of schedules)
      expect(
        (await store.get<Schedule>("schedules", s.id))?.nextFamilyAt,
      ).toBeNull();
  });

  it("retains a partially processed refresh through failure and restart, then delivers each family check once", async () => {
    const { store, schedules, sends, sender } = await setup({ count: 2 });
    for (const s of schedules)
      await store.set("schedules", s.id, { ...s, nextFamilyAt: null });
    const original = await store.get("reminderRefresh", "owner");
    store.beforeRead = (collection, id) => {
      if (collection !== "schedules" || id !== schedules[1].id) return;
      store.beforeRead = undefined;
      throw Error("synthetic refresh interruption");
    };
    await expect(refreshReminders(store, new Date(LATER))).rejects.toThrow(
      "synthetic refresh interruption",
    );
    expect((await store.get("reminderRefresh", "owner"))?.version).toBe(
      original?.version,
    );
    expect(
      (await store.get<Schedule>("schedules", schedules[0].id))?.nextFamilyAt,
    ).not.toBeNull();
    expect(
      (await store.get<Schedule>("schedules", schedules[1].id))?.nextFamilyAt,
    ).toBeNull();

    const restart = restored(store);
    const d = new Domain(restart);
    await tick(d, new Date(LATER), sender);
    await tick(d, new Date("2026-10-20T01:31:00.000Z"), sender);
    expect(await restart.get("reminderRefresh", "owner")).toBeNull();
    expect(sends.map((s) => s.uid)).toEqual(["caregiver", "caregiver"]);
    expect(new Set(sends.map((s) => s.id)).size).toBe(2);
  });

  it("resumes a failed migration without remigrating committed rows or duplicating reminders", async () => {
    const { store, schedules, sends, sender } = await setup({ count: 2 });
    await store.delete("reminderRefresh", "owner");
    for (const s of schedules) {
      const legacy: Schedule = { ...s };
      delete legacy.nextFamilyAt;
      delete legacy.reminderSchemaVersion;
      delete legacy.reminderVersion;
      await store.set("schedules", s.id, legacy);
    }
    store.beforeRead = (collection, id) => {
      if (collection !== "schedules" || id !== schedules[1].id) return;
      store.beforeRead = undefined;
      throw Error("synthetic migration interruption");
    };
    await expect(ensureReminderIndex(store, new Date(LATER))).rejects.toThrow(
      "synthetic migration interruption",
    );
    const committed = await store.get<Schedule>("schedules", schedules[0].id);
    expect(committed?.reminderSchemaVersion).toBe(1);
    expect(
      (await store.get<Schedule>("schedules", schedules[1].id))
        ?.reminderSchemaVersion,
    ).toBeUndefined();
    expect(await store.get("settings", "reminder-due-v1")).toBeNull();

    const restart = restored(store);
    const d = new Domain(restart);
    await tick(d, new Date(LATER), sender);
    await tick(d, new Date("2026-10-20T01:31:00.000Z"), sender);
    expect((await restart.get("settings", "reminder-due-v1"))?.ready).toBe(
      true,
    );
    expect(
      (await restart.get<Schedule>("schedules", schedules[0].id))
        ?.reminderVersion,
    ).toBe(committed?.reminderVersion);
    expect(
      (await restart.get<Schedule>("schedules", schedules[1].id))
        ?.reminderSchemaVersion,
    ).toBe(1);
    expect(sends.map((s) => s.uid)).toEqual(["caregiver", "caregiver"]);
    expect(new Set(sends.map((s) => s.id)).size).toBe(2);
  });
});

describe("reminder compatibility and midnight recovery", () => {
  it("recovers only the recent owner dose across Taipei midnight after an earlier stale checkpoint", async () => {
    const { d, store, sender, sends } = await setup({
      family: false,
      times: ["23:00", "23:40"],
    });
    await tick(d, new Date("2026-10-20T16:10:00.000Z"), sender);
    await tick(d, new Date("2026-10-20T16:11:00.000Z"), sender);
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    const notifications = await store.list("notifications");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].dueAt).toBe("2026-10-20T15:40:00.000Z");
  });

  it("revalidates and resumes an old pending notification lacking scheduleId", async () => {
    const { d, store, sender, sends, schedules } = await setup({
      family: false,
    });
    await tick(d, new Date(DUE), async () => {
      throw Error("synthetic old sender outage");
    });
    const pending = (await store.list("notifications"))[0];
    expect(pending.status).toBe("pending");
    delete pending.scheduleId;
    await store.set("notifications", pending.id, pending);
    const restart = restored(store);
    const restartedDomain = new Domain(restart);
    await tick(restartedDomain, new Date("2026-10-20T00:01:00.000Z"), sender);
    await tick(restartedDomain, new Date("2026-10-20T00:02:00.000Z"), sender);
    expect(sends.map((s) => s.uid)).toEqual(["owner"]);
    expect(await restart.get("notifications", pending.id)).toMatchObject({
      scheduleId: schedules[0].id,
      status: "sent",
    });
  });
});

describe("notification completion after delivery ownership is lost", () => {
  it.each(["success", "failure"] as const)(
    "does not overwrite a newer in-flight lease when the old sender finishes with %s",
    async (outcome) => {
      const { d, store } = await setup({ family: false });
      const oldEntered = deferred();
      const releaseOld = deferred();
      const newEntered = deferred();
      const releaseNew = deferred();
      const first = tick(d, new Date(DUE), async () => {
        oldEntered.resolve();
        await releaseOld.promise;
        if (outcome === "failure") throw Error("late old sender failure");
      });
      let second: Promise<unknown> | undefined;
      try {
        await oldEntered.promise;
        const old = (await store.list("notifications"))[0];
        second = tick(d, new Date("2026-10-20T00:02:00.000Z"), async () => {
          newEntered.resolve();
          await releaseNew.promise;
        });
        await newEntered.promise;
        const newer = await store.get("notifications", old.id);
        expect(newer?.deliveryToken).not.toBe(old.deliveryToken);
        expect(newer?.leaseUntil).toBe(Date.parse("2026-10-20T00:04:00.000Z"));
        releaseOld.resolve();
        await first;
        expect(await store.get("notifications", old.id)).toEqual(newer);
        releaseNew.resolve();
        await second;
        expect((await store.get("notifications", old.id))?.status).toBe("sent");
      } finally {
        releaseOld.resolve();
        releaseNew.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "preserves a newer retry backoff when the old sender finishes with %s",
    async (outcome) => {
      const { d, store, sender, sends } = await setup({ family: false });
      const entered = deferred();
      const release = deferred();
      const first = tick(d, new Date(DUE), async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") throw Error("late old sender failure");
      });
      try {
        await entered.promise;
        const old = (await store.list("notifications"))[0];
        await tick(d, new Date("2026-10-20T00:02:00.000Z"), async () => {
          throw Error("new sender needs a retry");
        });
        const newer = await store.get("notifications", old.id);
        expect(newer?.deliveryToken).not.toBe(old.deliveryToken);
        expect(newer?.leaseUntil).toBe(Date.parse("2026-10-20T00:03:00.000Z"));
        release.resolve();
        await first;
        expect(await store.get("notifications", old.id)).toEqual(newer);
        await tick(d, new Date("2026-10-20T00:03:00.000Z"), sender);
        expect(sends).toHaveLength(1);
        expect((await store.get("notifications", old.id))?.status).toBe("sent");
      } finally {
        release.resolve();
        await Promise.allSettled([first]);
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "does not resurrect a cancelled notification when the old sender finishes with %s",
    async (outcome) => {
      const { d, store, schedules } = await setup({ family: false });
      const entered = deferred();
      const release = deferred();
      const first = tick(d, new Date(DUE), async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") throw Error("late old sender failure");
      });
      try {
        await entered.promise;
        const old = (await store.list("notifications"))[0];
        await d.doseLog("owner", {
          medicationId: schedules[0].medicationId,
          dueAt: DUE,
          status: "taken",
        });
        let sends = 0;
        await tick(d, new Date("2026-10-20T00:02:00.000Z"), async () => {
          sends++;
        });
        expect(sends).toBe(0);
        const cancelled = await store.get("notifications", old.id);
        expect(cancelled?.status).toBe("cancelled");
        release.resolve();
        await first;
        expect(await store.get("notifications", old.id)).toEqual(cancelled);
      } finally {
        release.resolve();
        await Promise.allSettled([first]);
      }
    },
  );
});
