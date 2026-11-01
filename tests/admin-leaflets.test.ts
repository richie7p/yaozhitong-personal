import { afterEach, expect, it, vi } from "vitest";
import { Firestore, FieldPath, Query } from "firebase-admin/firestore";
import { AdminLeaflets } from "../server/admin-leaflets";
import { FirestoreStore, MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { Domain } from "../server/domain";
import { localToken } from "../server/auth";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const store = new MemoryStore();
  store.data.leaflets = Object.fromEntries(
    Array.from({ length: 3713 }, (_, i) => {
      const id = "leaflet-" + String(i).padStart(4, "0");
      return [
        id,
        {
          id,
          licenseNo: "LICENSE-" + (i % 4),
          version: "v1",
          status: i < 3710 ? "published" : i === 3710 ? "retired" : "draft",
          sourceUrl: "https://example.invalid/synthetic",
          chunks: [
            { id: id + "-p1", text: "Synthetic source content. ".repeat(2000) },
          ],
        },
      ];
    }),
  );
  return store;
}
it("keeps a 3,713-record library bounded and excludes full source text from every page", async () => {
  const store = fixture(),
    service = new AdminLeaflets(store);
  const scan = vi.spyOn(store, "list"),
    pageQuery = vi.spyOn(store, "page");
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.page({ cursor, limit: "50" });
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(15000);
    for (const item of page.items) {
      expect(item).not.toHaveProperty("chunks");
      seen.push(item.id);
    }
    cursor = page.nextCursor || undefined;
  } while (cursor);
  expect(seen).toEqual(Object.keys(store.data.leaflets).sort());
  expect(new Set(seen).size).toBe(3713);
  expect(scan).not.toHaveBeenCalled();
  expect(
    pageQuery.mock.calls.every(
      ([, q]) => q.limit === 51 && !q.fields?.includes("chunks"),
    ),
  ).toBe(true);
  expect(await service.stats()).toEqual({
    total: 3713,
    published: 3710,
    draft: 2,
    retired: 1,
  });
  expect((await service.detail(seen[0])).chunks).toHaveLength(1);
  await expect(service.detail("missing")).rejects.toMatchObject({
    status: 404,
  });
});
it("binds cursors to filters, validates page sizes, and never silently resets invalid requests", async () => {
  const store = fixture(),
    service = new AdminLeaflets(store);
  const first = await service.page({
    status: "published",
    licenseNo: "LICENSE-1",
    limit: "2",
  });
  const second = await service.page({
    status: "published",
    licenseNo: "LICENSE-1",
    limit: "2",
    cursor: first.nextCursor!,
  });
  expect(first.items.map((x) => x.id)).toEqual([
    "leaflet-0001",
    "leaflet-0005",
  ]);
  expect(second.items.map((x) => x.id)).toEqual([
    "leaflet-0009",
    "leaflet-0013",
  ]);
  await expect(
    service.page({ status: "draft", cursor: first.nextCursor! }),
  ).rejects.toMatchObject({ status: 400 });
  for (const cursor of [
    "bad%%%",
    "e30",
    Buffer.from(
      JSON.stringify({ v: 1, id: "a/b", status: "", licenseNo: "" }),
    ).toString("base64url"),
  ])
    await expect(service.page({ cursor })).rejects.toMatchObject({
      status: 400,
    });
  for (const limit of ["0", "-1", "51", "1.5", "NaN"])
    await expect(service.page({ limit })).rejects.toThrow();
  expect((await service.page({ licenseNo: "absent" })).items).toEqual([]);
});
it("sends projection, cursor, filters and a row limit to the real Firestore query builder", async () => {
  const db = new Firestore({ projectId: "synthetic-admin-pagination" });
  const store = Object.create(FirestoreStore.prototype) as FirestoreStore;
  store.db = db;
  const queries: Query[] = [];
  vi.spyOn(Query.prototype, "get").mockImplementation(async function (
    this: Query,
  ) {
    queries.push(this);
    return {
      docs: [
        {
          id: "real-document-id",
          data: () => ({ id: "stale-field-id", licenseNo: "LICENSE-1" }),
        },
      ],
    } as any;
  });
  const rows = await store.page("leaflets", {
    limit: 21,
    after: "leaflet-0001",
    where: [
      ["status", "published"],
      ["licenseNo", "LICENSE-1"],
    ],
    fields: ["licenseNo", "status"],
  });
  expect(rows).toEqual([{ id: "real-document-id", licenseNo: "LICENSE-1" }]);
  expect(
    queries[0].isEqual(
      db
        .collection("leaflets")
        .orderBy(FieldPath.documentId())
        .where("status", "==", "published")
        .where("licenseNo", "==", "LICENSE-1")
        .startAfter("leaflet-0001")
        .select("licenseNo", "status")
        .limit(21),
    ),
  ).toBe(true);
});
it("enforces server roles for list, statistics and full text, including attempted self-promotion", async () => {
  const store = fixture(),
    app = createApp(new Domain(store));
  const admin = { authorization: "Bearer " + localToken("local-admin") },
    user = { authorization: "Bearer " + localToken("local-owner") };
  for (const path of [
    "/api/v1/admin/leaflets",
    "/api/v1/admin/leaflets/stats",
    "/api/v1/admin/leaflets/leaflet-0000",
  ]) {
    expect((await app.request(path)).status).toBe(401);
    expect(
      (await app.request(path + "?admin=true", { headers: user })).status,
    ).toBe(403);
    expect((await app.request(path, { headers: admin })).status).toBe(200);
  }
  expect(
    (
      await app.request("/api/v1/me", {
        method: "PUT",
        headers: { ...user, "content-type": "application/json" },
        body: JSON.stringify({ admin: true }),
      })
    ).status,
  ).toBe(400);
  expect(store.data.users["local-owner"].admin).toBe(false);
  expect(
    (await app.request("/api/v1/admin/leaflets?limit=51", { headers: admin }))
      .status,
  ).toBe(400);
  expect(
    (await app.request("/api/v1/admin/leaflets/missing", { headers: admin }))
      .status,
  ).toBe(404);
});
