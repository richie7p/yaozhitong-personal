import { describe, expect, it, vi } from "vitest";
import { Catalog, scoreDrug } from "../server/catalog";
import { MemoryStore } from "../server/store";
import type { Blobs } from "../server/blobs";
import type { Drug } from "../shared/schema";
const drug = (id: string): Drug => ({
  licenseNo: id,
  nameZh: id,
  nameEn: id,
  strength: "1mg",
  form: "錠劑",
  ingredients: [],
  revoked: false,
});
const encoded = (id: string) => Buffer.from(JSON.stringify([drug(id)]));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("catalog concurrent cold loads and version changes", () => {
  it("keys cached rankings by strength/form, isolates returned mutations and replaces them with a new version", async () => {
    const store = new MemoryStore();
    const rows = [
      {
        ...drug("A"),
        nameZh: "合成藥",
        strength: "1mg",
        ingredients: ["Synthetic"],
      },
      { ...drug("B"), nameZh: "合成藥", strength: "2mg" },
      { ...drug("C"), nameZh: "合成藥", strength: "1mg", form: "膠囊劑" },
    ];
    await store.set("settings", "catalog", {
      version: "v1",
      path: "catalog/v1.json",
    });
    const get = vi.fn(async () => Buffer.from(JSON.stringify(rows)));
    const catalog = new Catalog(store, { get } as unknown as Blobs);
    for (const [strength, form] of [
      ["", ""],
      ["1mg", "錠劑"],
      ["2mg", "錠劑"],
      ["1mg", "膠囊劑"],
    ]) {
      const expected = rows
        .map((row) => ({
          ...row,
          score: scoreDrug(row, "合成藥", strength, form),
        }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score);
      expect(await catalog.search("合成藥", strength, form)).toEqual(expected);
      const first = await catalog.search("合成藥", strength, form);
      first[0].nameZh = "mutated";
      first[0].ingredients.push("mutated");
      expect(await catalog.search("合成藥", strength, form)).toEqual(expected);
    }
    await store.set("settings", "catalog", {
      version: "v2",
      path: "catalog/v2.json",
    });
    get.mockImplementation(async () => encoded("D"));
    await catalog.identitySnapshot();
    expect(await catalog.search("合成藥", "1mg", "錠劑")).toEqual([]);
  });

  it("50 concurrent cold identity reads share one blob parse without sharing stale metadata across requests", async () => {
    const store = new MemoryStore();
    await store.set("settings", "catalog", {
      version: "v1",
      path: "catalog/v1.json",
    });
    const gate = deferred();
    const get = vi.fn(async () => {
      await gate.promise;
      return encoded("A");
    });
    const catalog = new Catalog(store, { get } as unknown as Blobs);
    const reads = Array.from({ length: 50 }, () => catalog.identitySnapshot());
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    gate.resolve();
    const values = await Promise.all(reads);
    expect(get).toHaveBeenCalledOnce();
    expect(values.every((value) => value === values[0])).toBe(true);
    await store.set("settings", "catalog", {
      version: "v2",
      path: "catalog/v2.json",
    });
    get.mockImplementation(async () => encoded("B"));
    const current = await catalog.identitySnapshot();
    expect(
      current.review({
        identityEvidence: {
          method: "license",
          printedLicenseNo: "A",
          printedName: "",
          printedStrength: "",
          printedForm: "",
        },
      }).status,
    ).toBe("needs_information");
    expect(
      current.review({
        identityEvidence: {
          method: "license",
          printedLicenseNo: "B",
          printedName: "",
          printedStrength: "",
          printedForm: "",
        },
      }).status,
    ).toBe("confirmed");
  });
  it("does not roll the shared cache back when an earlier version load finishes last", async () => {
    const store = new MemoryStore();
    await store.set("settings", "catalog", {
      version: "v1",
      path: "catalog/v1.json",
    });
    const a = deferred();
    const entered = deferred();
    const get = vi.fn(async (path: string) => {
      if (path.includes("v1")) {
        entered.resolve();
        await a.promise;
        return encoded("A");
      }
      return encoded("B");
    });
    const catalog = new Catalog(store, { get } as unknown as Blobs);
    const first = catalog.all(true);
    await entered.promise;
    await store.set("settings", "catalog", {
      version: "v2",
      path: "catalog/v2.json",
    });
    expect((await catalog.all(true))[0].licenseNo).toBe("B");
    a.resolve();
    expect((await first)[0].licenseNo).toBe("A");
    expect((await catalog.all())[0].licenseNo).toBe("B");
  });
  it("drops a failed shared load so the next request can recover", async () => {
    const store = new MemoryStore();
    await store.set("settings", "catalog", {
      version: "v1",
      path: "catalog/v1.json",
    });
    const gate = deferred();
    const get = vi.fn(async (): Promise<Buffer> => {
      await gate.promise;
      throw new Error("synthetic storage outage");
    });
    const catalog = new Catalog(store, { get } as unknown as Blobs);
    const reads = Array.from({ length: 20 }, () => catalog.all(true));
    const finished = Promise.allSettled(reads);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    gate.resolve();
    expect((await finished).every((r) => r.status === "rejected")).toBe(true);
    expect(get).toHaveBeenCalledOnce();
    get.mockImplementation(async () => encoded("A"));
    expect((await catalog.all(true))[0].licenseNo).toBe("A");
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("clears the current cache when catalog metadata is removed during an older blob load", async () => {
    const store = new MemoryStore();
    await store.set("settings", "catalog", {
      version: "v1",
      path: "catalog/v1.json",
    });
    const gate = deferred();
    const entered = deferred();
    const get = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      return encoded("A");
    });
    const catalog = new Catalog(store, { get } as unknown as Blobs);
    const old = catalog.all(true);
    await entered.promise;
    await store.delete("settings", "catalog");
    expect(await catalog.all(true)).toEqual([]);
    gate.resolve();
    await old;
    expect(await catalog.all()).toEqual([]);
  });
});
