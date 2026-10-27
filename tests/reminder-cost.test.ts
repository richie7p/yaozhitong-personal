import { expect, it } from "vitest";
import { config } from "../server/config";
import { Domain } from "../server/domain";
import { tick } from "../server/scheduler";
import { MemoryStore, type Doc, type Tx } from "../server/store";

class MeteredStore extends MemoryStore {
  reads = 0;
  writes = 0;
  queries = 0;
  emptyQueries = 0;
  directReads = 0;
  transactionReads = 0;

  resetMeter() {
    this.reads = this.writes = this.queries = this.emptyQueries = 0;
    this.directReads = this.transactionReads = 0;
  }

  override async get<T = Doc>(collection: string, id: string) {
    this.reads++;
    this.directReads++;
    return super.get<T>(collection, id);
  }

  override async list<T = Doc>(
    collection: string,
    where?: [string, unknown],
    and?: [string, unknown],
  ) {
    const rows = await super.list<T>(collection, where, and);
    this.countQuery(rows.length);
    return rows;
  }

  override async queryDue<T = Doc>(
    collection: string,
    field: string,
    cutoff: string | number,
    where?: [string, unknown],
  ) {
    const rows = await super.queryDue<T>(collection, field, cutoff, where);
    this.countQuery(rows.length);
    return rows;
  }

  override transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return super.transaction((tx) =>
      fn({
        get: async <R = Doc>(collection: string, id: string) => {
          this.reads++;
          this.transactionReads++;
          return tx.get<R>(collection, id);
        },
        set: (collection, id, value) => {
          this.writes++;
          tx.set(collection, id, value);
        },
        delete: (collection, id) => {
          this.writes++;
          tx.delete(collection, id);
        },
      }),
    );
  }

  private countQuery(rows: number) {
    this.queries++;
    if (!rows) this.emptyQueries++;
    // Firestore charges at least one document read even for an empty query.
    this.reads += Math.max(1, rows);
  }
}

it("reduces steady-state reminder reads by at least 95% for 50 owners while delivering every dose exactly once", async () => {
  const oldMode = config.mode;
  config.mode = "firebase";
  try {
    const store = new MeteredStore();
    const d = new Domain(store);
    const owners = 50;
    const schedulesPerOwner = 3;
    const scheduleCount = owners * schedulesPerOwner;
    store.data = {
      users: {},
      profiles: {},
      medications: {},
      schedules: {},
      devices: {},
    };
    for (let owner = 0; owner < owners; owner++) {
      const ownerId = `synthetic-owner-${owner}`;
      store.data.users[ownerId] = {
        id: ownerId,
        disabled: false,
        deleting: false,
      };
      store.data.profiles[ownerId] = { ownerId, notifyFamily: false };
      store.data.devices[ownerId] = {
        id: ownerId,
        ownerId,
        token: "synthetic-never-sent",
      };
      for (let index = 0; index < schedulesPerOwner; index++) {
        const medicationId = `${ownerId}-medication-${index}`;
        const scheduleId = `${ownerId}-schedule-${index}`;
        store.data.medications[medicationId] = {
          id: medicationId,
          ownerId,
          revision: 1,
          confirmed: true,
          prn: false,
          archived: false,
        };
        store.data.schedules[scheduleId] = {
          id: scheduleId,
          ownerId,
          medicationId,
          medicationRevision: 1,
          active: true,
          times: ["08:00"],
          timezone: "Asia/Taipei",
          startDate: "2026-10-19",
          endDate: null,
          nextAt: "2026-10-20T00:00:00.000Z",
        };
      }
    }
    const deliveries: { uid: string; id: string }[] = [];
    const send = async (uid: string, id: string) => {
      // Include the same owner-device lookup as messagingSender, with one
      // synthetic device per owner. Never contact Firebase or send a push.
      const devices = await store.list("devices", ["ownerId", uid]);
      expect(devices).toHaveLength(1);
      deliveries.push({ uid, id });
    };
    // Complete the one-time legacy migration and family-consent checkpoint
    // before measuring the unchanged schedules' steady-state daily cost.
    await tick(d, new Date("2026-10-19T15:59:00.000Z"), send);
    expect(deliveries).toEqual([]);
    expect(
      Object.values(store.data.schedules).every((s) => s.nextFamilyAt === null),
    ).toBe(true);
    store.resetMeter();

    const start = Date.parse("2026-10-19T16:00:00.000Z");
    for (let minute = 0; minute < 1440; minute++)
      await tick(d, new Date(start + minute * 60000), send);

    const previousScheduleReads = 4 * scheduleCount * 1440;
    const reduction = 1 - store.reads / previousScheduleReads;
    expect(reduction).toBeGreaterThanOrEqual(0.95);
    expect(deliveries).toHaveLength(scheduleCount);
    expect(new Set(deliveries.map((delivery) => delivery.id)).size).toBe(
      scheduleCount,
    );
    expect(Object.keys(store.data.notifications)).toHaveLength(scheduleCount);
    expect(
      Object.values(store.data.notifications).every((n) => n.status === "sent"),
    ).toBe(true);
    for (const ownerId of Object.keys(store.data.users))
      expect(
        deliveries.filter((delivery) => delivery.uid === ownerId),
      ).toHaveLength(schedulesPerOwner);

    console.info(
      "REMINDER_READ_BENCHMARK",
      JSON.stringify({
        owners,
        schedules: scheduleCount,
        dosesPerSchedulePerDay: 1,
        familyNotifications: false,
        registeredDevicesPerOwner: 1,
        minutes: 1440,
        previousScheduleReadsPerDay: previousScheduleReads,
        measuredWholeTickReadsPerDay: store.reads,
        previousScheduleReadsPer30Days: previousScheduleReads * 30,
        measuredWholeTickReadsPer30Days: store.reads * 30,
        reductionPercent: Number((reduction * 100).toFixed(3)),
        queries: store.queries,
        emptyQueries: store.emptyQueries,
        directReads: store.directReads,
        transactionReads: store.transactionReads,
        writes: store.writes,
        deliveries: deliveries.length,
        exclusions: [
          "one-time migration and user changes",
          "Firestore transaction retries and index-entry billing",
          "web/API traffic, AI jobs, family reminders, backup, storage and networking",
        ],
      }),
    );
  } finally {
    config.mode = oldMode;
  }
}, 30000);
