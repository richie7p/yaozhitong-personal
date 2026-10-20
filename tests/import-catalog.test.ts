import { describe, expect, it } from "vitest";
import { Blobs } from "../server/blobs";
import { refreshCatalog } from "../server/import-catalog";
import { MemoryStore } from "../server/store";
import type { Drug } from "../shared/schema";

class MemoryBlobs extends Blobs {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, Buffer.from(data));
    return key;
  }
  async get(key: string) {
    return this.files.get(key)!;
  }
}

async function importRows(records: Record<string, unknown>[]) {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const metadata = await refreshCatalog(
    store,
    blobs,
    Buffer.from(
      JSON.stringify(
        records.map((record, index) => ({
          許可證字號: `SYNTHETIC-IMPORT-${index}`,
          ...record,
        })),
      ),
    ),
  );
  return {
    rows: JSON.parse((await blobs.get(metadata.path)).toString()) as Drug[],
    metadata,
    store,
  };
}

describe("official catalog strength import", () => {
  it.each([
    ["合成滴劑１００ｍｇ／ｍｌ", "100mg/ml"],
    ["合成滴劑100毫克/毫升", "100毫克/毫升"],
    ["合成乳膏10mg/g", "10mg/g"],
    ["合成糖漿125 mg/5 mL", "125 mg/5 mL"],
    ["合成糖漿1毫克/5毫升", "1毫克/5毫升"],
    ["合成溶液0.5%", "0.5%"],
    ["合成溶液1% (w/v)", "1% (w/v)"],
    ["合成溶液2%w/w", "2%w/w"],
    ["合成錠200毫克(合成甲)", "200毫克"],
    ["合成錠 5 MG", "5 MG"],
    ["合成膠囊２５０微克", "250微克"],
    ["合成錠B12 100mcg", "100mcg"],
  ])(
    "preserves one complete explicit strength in %s",
    async (title, expected) => {
      const { rows } = await importRows([{ 中文品名: title }]);
      expect(rows[0].strength).toBe(expected);
    },
  );

  it.each([
    "合成錠B12",
    "合成B12MG錠",
    "合成錠5mg+100mg",
    "合成錠5/100mg",
    "合成錠5 / 100mg",
    "合成錠5mg/100mg",
    "合成錠5、100mg",
    "合成錠5-10mg",
    "合成滴劑100mg/",
    "合成滴劑100mg/瓶",
    "合成滴劑100mg/ml 10ml",
    "合成錠1,000mg",
    "合成錠100",
    "合成複方錠500mg",
  ])("leaves ambiguous, incomplete or unitless %s empty", async (title) => {
    const { rows } = await importRows([{ 中文品名: title }]);
    expect(rows[0].strength).toBe("");
  });

  it("preserves a supplied complete strength and the remaining catalog fields", async () => {
    const { rows, metadata, store } = await importRows([
      {
        中文品名: "合成複方錠5/100mg",
        英文品名: "Synthetic combination tablets",
        strength: "5mg + 100mg",
        劑型: "膜衣錠",
        主成分略述: "SYNTHETIC A;;SYNTHETIC B",
        註銷狀態: "已註銷",
      },
    ]);
    expect(rows[0]).toEqual({
      licenseNo: "SYNTHETIC-IMPORT-0",
      nameZh: "合成複方錠5/100mg",
      nameEn: "Synthetic combination tablets",
      strength: "5mg + 100mg",
      form: "膜衣錠",
      ingredients: ["SYNTHETIC A", "SYNTHETIC B"],
      revoked: true,
    });
    expect(metadata.count).toBe(1);
    expect(await store.get("settings", "catalog")).toEqual(metadata);
  });

  it("does not infer one component strength for a known combination product", async () => {
    const { rows } = await importRows([
      { 中文品名: "合成錠500mg", 主成分略述: "SYNTHETIC A;;SYNTHETIC B" },
      { 中文品名: "合成錠500mg", ingredients: ["SYNTHETIC A", "SYNTHETIC B"] },
    ]);
    expect(rows.map((row) => row.strength)).toEqual(["", ""]);
  });
});
