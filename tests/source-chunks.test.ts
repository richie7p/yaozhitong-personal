import { describe, expect, it } from "vitest";
import { canonicalPageChunk } from "../server/leaflets";
import {
  SOURCE_CHUNKING_VERSION,
  SOURCE_PAGE_CHAR_LIMIT,
} from "../shared/source";

const make = (text: string, page = 1, version = "pdf-v1") =>
  canonicalPageChunk(
    "synthetic-leaflet-sha",
    "SYNTHETIC-LICENSE",
    version,
    page,
    text,
  );

describe("whole-page canonical sources", () => {
  it("retains a warning and its continuation across the former 1000-character boundary", () => {
    const text =
      "【警語】" +
      "合成背景。".repeat(195) +
      "大部份發生於合成條件甲。如果出現上述症狀，請依完整來源處理。";
    expect(text.length).toBeGreaterThan(1000);
    const chunk = make(text)!;
    expect(chunk.text).toBe(text);
    expect(chunk.start).toBe(0);
    expect(chunk.text).toContain("大部份發生於合成條件甲。如果出現上述症狀");
    expect(chunk.id).toContain(SOURCE_CHUNKING_VERSION);
  });

  it("preserves all source characters and short page tails", () => {
    const text = " \n【警語】原文。\n　短尾\n ";
    expect(make(text)!.text).toBe(text);
    expect(make("短尾")!.text).toBe("短尾");
    expect(make(" \n　 ")).toBeNull();
  });

  it("keeps adjacent pages separate and gives each its own identity", () => {
    const first = make("同一份完整合成原文。", 1)!;
    const second = make("同一份完整合成原文。", 2)!;
    expect(first.page).toBe(1);
    expect(second.page).toBe(2);
    expect(first.id).not.toBe(second.id);
    expect(first.text).toBe(second.text);
  });

  it("uses stable source identities while detecting changed page text", () => {
    expect(make("完整合成警語甲。")!.id).toBe(make("完整合成警語甲。")!.id);
    expect(make("完整合成警語甲。")!.id).not.toBe(make("完整合成警語乙。")!.id);
    expect(make("完整合成警語甲。", 1, "pdf-v2")!.version).toBe("pdf-v2");
  });

  it("accepts a whole page at the source budget without clipping", () => {
    const text = "甲".repeat(SOURCE_PAGE_CHAR_LIMIT);
    expect(make(text)!.text).toBe(text);
  });

  it("rejects an oversized page instead of publishing a partial warning", () => {
    expect(() => make("甲".repeat(SOURCE_PAGE_CHAR_LIMIT + 1))).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects an invalid page %s", (page) => {
    expect(() => make("完整合成警語。", page)).toThrow();
  });
});
