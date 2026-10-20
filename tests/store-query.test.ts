import { expect, it, vi } from "vitest";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Firestore, Query } from "firebase-admin/firestore";
import { FirestoreStore, MemoryStore } from "../server/store";
import indexes from "../firestore.indexes.json";

it("returns only active dates up to the inclusive cutoff, sorted by date and document ID", async () => {
  const store = new MemoryStore();
  store.data.schedules = {
    z: { id: "z", active: true, nextAt: "2026-10-20T04:00:00.000Z" },
    future: { id: "future", active: true, nextAt: "2026-10-20T04:01:00.000Z" },
    missing: { id: "missing", active: true },
    null: { id: "null", active: true, nextAt: null },
    inactive: {
      id: "inactive",
      active: false,
      nextAt: "2026-10-19T00:00:00.000Z",
    },
    old: { id: "old", active: true, nextAt: "2026-10-19T23:00:00.000Z" },
    a: { id: "a", active: true, nextAt: "2026-10-20T04:00:00.000Z" },
    numeric: { id: "numeric", active: true, nextAt: 0 },
  };
  const result = await store.queryDue(
    "schedules",
    "nextAt",
    "2026-10-20T04:00:00.000Z",
    ["active", true],
  );
  expect(result.map((row) => row.id)).toEqual(["old", "a", "z"]);
  result[0].nextAt = "changed";
  expect(store.data.schedules.old.nextAt).toBe("2026-10-19T23:00:00.000Z");
});

it("does not coerce missing, null, string or boolean leases into numeric due dates", async () => {
  const store = new MemoryStore();
  store.data.jobs = {
    zero: { id: "zero", status: "running", leaseUntil: 0 },
    boundary: { id: "boundary", status: "running", leaseUntil: 100 },
    later: { id: "later", status: "running", leaseUntil: 101 },
    wrongStatus: { id: "wrongStatus", status: "succeeded", leaseUntil: 0 },
    missing: { id: "missing", status: "running" },
    null: { id: "null", status: "running", leaseUntil: null },
    string: { id: "string", status: "running", leaseUntil: "50" },
    boolean: { id: "boolean", status: "running", leaseUntil: false },
  };
  expect(
    (
      await store.queryDue("jobs", "leaseUntil", 100, ["status", "running"])
    ).map((row) => row.id),
  ).toEqual(["zero", "boundary"]);
  expect(
    (await store.queryDue("jobs", "leaseUntil", 100)).map((row) => row.id),
  ).toEqual(["wrongStatus", "zero", "boundary"]);
});

it("returns empty for unknown collections and does not truncate an overdue backlog", async () => {
  const store = new MemoryStore();
  expect(await store.queryDue("missing", "leaseUntil", 100)).toEqual([]);
  store.data.jobs = Object.fromEntries(
    Array.from({ length: 1205 }, (_, index) => [
      `job-${index}`,
      { id: `job-${index}`, leaseUntil: index },
    ]),
  );
  const rows = await store.queryDue("jobs", "leaseUntil", 1204);
  expect(rows).toHaveLength(1205);
  expect(rows[0].leaseUntil).toBe(0);
  expect(rows.at(-1)?.leaseUntil).toBe(1204);
});

it("reloads a file-backed store exactly once per query and sees external updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yzt-due-query-test-"));
  const file = join(dir, "db.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        schedules: { old: { id: "old", active: true, nextAt: "2026-10-20" } },
      }),
    );
    const store = new MemoryStore(file);
    const reload = vi.spyOn(store, "load");
    expect(
      (await store.queryDue("schedules", "nextAt", "2026-10-20")).map(
        (row) => row.id,
      ),
    ).toEqual(["old"]);
    expect(reload).toHaveBeenCalledTimes(1);
    await writeFile(
      file,
      JSON.stringify({
        schedules: { new: { id: "new", active: true, nextAt: "2026-10-19" } },
      }),
    );
    expect(
      (await store.queryDue("schedules", "nextAt", "2026-10-20")).map(
        (row) => row.id,
      ),
    ).toEqual(["new"]);
    expect(reload).toHaveBeenCalledTimes(2);
  } finally {
    await unlink(file).catch(() => {});
    await rmdir(dir);
  }
});

const dueIndexes = [
  ["schedules", "nextAt", "active", true, "2026-10-20T04:00:00.000Z"],
  ["schedules", "nextFamilyAt", "active", true, "2026-10-20T04:00:00.000Z"],
  ["notifications", "leaseUntil", "status", "sending", 1000],
  ["jobs", "leaseUntil", "status", "running", 1000],
] as const;

it.each(dueIndexes)(
  "sends the %s.%s range and equality to Firestore and has the matching deployed index",
  async (collection, field, equalityField, equalityValue, cutoff) => {
    // Use the real SDK query builder and intercept only network execution.
    // This checks that filtering reaches Firestore rather than following a
    // collection scan in application code.
    const db = new Firestore({ projectId: "synthetic-due-query-test" });
    const store = Object.create(FirestoreStore.prototype) as FirestoreStore;
    store.db = db;
    const captured: Query[] = [];
    const rows = [{ id: "synthetic-due", [field]: cutoff }];
    const stream = vi
      .spyOn(Query.prototype, "stream")
      .mockImplementation(function (this: Query) {
        captured.push(this);
        return Readable.from(rows.map((row) => ({ data: () => row })));
      });
    try {
      expect(
        await store.queryDue(collection, field, cutoff, [
          equalityField,
          equalityValue,
        ]),
      ).toEqual(rows);
      expect(captured).toHaveLength(1);
      expect(
        captured[0].isEqual(
          db
            .collection(collection)
            .where(field, "<=", cutoff)
            .where(equalityField, "==", equalityValue)
            .orderBy(field, "asc"),
        ),
      ).toBe(true);
      expect(indexes.indexes).toContainEqual({
        collectionGroup: collection,
        queryScope: "COLLECTION",
        fields: [
          { fieldPath: equalityField, order: "ASCENDING" },
          { fieldPath: field, order: "ASCENDING" },
        ],
      });
    } finally {
      stream.mockRestore();
    }
  },
);

it("streams an unqualified due query and propagates Firestore errors without falling back to a full scan", async () => {
  const db = new Firestore({ projectId: "synthetic-due-query-test" });
  const store = Object.create(FirestoreStore.prototype) as FirestoreStore;
  store.db = db;
  const captured: Query[] = [];
  const stream = vi
    .spyOn(Query.prototype, "stream")
    .mockImplementation(function (this: Query) {
      captured.push(this);
      return Readable.from(
        (async function* () {
          throw Error("synthetic unavailable index");
        })(),
      );
    });
  const fullScan = vi.spyOn(store, "list");
  try {
    await expect(store.queryDue("jobs", "leaseUntil", 100)).rejects.toThrow(
      "synthetic unavailable index",
    );
    expect(captured).toHaveLength(1);
    expect(
      captured[0].isEqual(
        db
          .collection("jobs")
          .where("leaseUntil", "<=", 100)
          .orderBy("leaseUntil", "asc"),
      ),
    ).toBe(true);
    expect(fullScan).not.toHaveBeenCalled();
  } finally {
    stream.mockRestore();
    fullScan.mockRestore();
  }
});
