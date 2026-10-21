import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Frequency,
  MedicationIdentity,
  frequencyExplanation,
  medicationIdentity,
  recordIdentity,
} from "../src/medication-presentation";

describe("frequency explanations preserve source boundaries", () => {
  it.each([undefined, null, 3, {}, ["TID"]])(
    "does not explain non-string legacy input %s",
    (raw) => {
      expect(frequencyExplanation(raw)).toBeNull();
    },
  );

  it.each([undefined, null])(
    "shows a fallback for missing raw frequency %s",
    (raw) => {
      const html = renderToStaticMarkup(createElement(Frequency, { raw }));
      expect(html).toContain("頻次待確認");
      expect(html).not.toContain("frequency-explanation");
    },
  );
  it.each([
    ["QD", "每日一次"],
    ["BID", "每日兩次"],
    ["TID", "每日三次"],
    ["QID", "每日四次"],
    ["prn", "需要時使用"],
    ["AC", "飯前"],
    ["PC", "飯後"],
    ["HS", "睡前一次"],
    ["QDHS", "每日一次，睡前使用"],
    ["BID&HS", "每日兩次，且睡前再一次"],
    ["TID&HS", "每日三次，且睡前再一次"],
    ["TID AC", "每日三次，飯前"],
    ["  bid\tpc  ", "每日兩次，飯後"],
  ])("explains the complete recognized expression %s", (raw, explanation) => {
    expect(frequencyExplanation(raw)).toBe(explanation);
    expect(explanation).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it.each([
    "",
    "   ",
    "QOD",
    "QD/BID",
    "TID/AC",
    "TID+AC",
    "TID OR PRN",
    "BID PRN",
    "BID PRN PC",
    "AC PC",
    "BID BID",
    "QD HS",
    "TID AC PC",
    "TID\nPC",
    "QD；PC",
    "TID（依醫師指示）",
    "非 TID",
    "bıd",
    "每日三次",
    "constructor",
    "__proto__",
  ])("does not infer a meaning from unknown or mixed source %s", (raw) => {
    expect(frequencyExplanation(raw)).toBeNull();
  });

  it("keeps the exact source case, whitespace and punctuation in rendered text", () => {
    const raw = "  bid\tpc  ";
    const html = renderToStaticMarkup(createElement(Frequency, { raw }));
    expect(html).toContain(`>${raw}</span>`);
    expect(html).toContain("（每日兩次，飯後）");
    expect(raw).toBe("  bid\tpc  ");

    const unknown = renderToStaticMarkup(
      createElement(Frequency, { raw: "TID/AC（待確認）" }),
    );
    expect(unknown).toContain(">TID/AC（待確認）</span>");
    expect(unknown).not.toContain("frequency-explanation");
    expect(
      renderToStaticMarkup(createElement(Frequency, { raw: "" })),
    ).toContain("頻次待確認");
  });
});

describe("prescription identity display", () => {
  const prescription = {
    name: "同名藥品",
    strength: "10mg",
    form: "錠劑",
    doseAmount: 0.5,
    doseUnit: "錠",
    frequencyRaw: "BID",
    route: "口服",
    createdAt: "2026-10-20T23:30:12.000Z",
    id: "prescription-record-12345678",
  };

  it("includes dose, route, frequency, Taipei creation timestamp and stable short ID", () => {
    const original = { ...prescription };
    const label = medicationIdentity(prescription);
    expect(label).toBe(
      "10mg · 錠劑 · 每次 0.5 錠 · 口服 · BID（每日兩次） · 建立 2026/10/21 07:30:12（臺北時間） · 編號 …12345678",
    );
    expect(label).not.toContain(prescription.name);
    expect(prescription).toEqual(original);
    expect(medicationIdentity(prescription)).toBe(label);
  });

  it("keeps separate same-name prescriptions distinguishable without merging", () => {
    const records = [
      prescription,
      { ...prescription, doseAmount: 1 },
      { ...prescription, route: "外用" },
      { ...prescription, frequencyRaw: "QD" },
      { ...prescription, createdAt: "2026-10-21T23:30:12.000Z" },
      { ...prescription, id: "prescription-record-87654321" },
    ];
    const labels = records.map(medicationIdentity);
    expect(new Set(labels).size).toBe(records.length);
    expect(records).toHaveLength(6);
  });

  it("retains literal frequency and expands only recognized usage in selector labels", () => {
    expect(medicationIdentity({ frequencyRaw: "TID" })).toContain(
      "TID（每日三次）",
    );
    expect(medicationIdentity({ frequencyRaw: " bid PC " })).toContain(
      " bid PC （每日兩次，飯後）",
    );
    expect(medicationIdentity({ frequencyRaw: "QD/BID" })).toContain(
      "QD/BID ·",
    );
  });

  it("uses confirmed literal doses and handles old or incomplete records", () => {
    expect(medicationIdentity({ doseText: "適量", doseAmount: null })).toBe(
      "每次 適量 · 途徑待確認 · 頻次待確認 · 建立時間未記錄",
    );
    expect(medicationIdentity({})).toBe(
      "用量待確認 · 途徑待確認 · 頻次待確認 · 建立時間未記錄",
    );
    expect(recordIdentity({ id: "short" })).toBe(
      "建立時間未記錄 · 編號 …short",
    );
  });

  it.each([
    undefined,
    "",
    "not-a-date",
    "2026-02-30T08:00:00Z",
    "2025-02-29T08:00:00Z",
    "2100-02-29T08:00:00Z",
    "2026-04-31T08:00:00Z",
    "2026-00-21T08:00:00Z",
    "2026-10-00T08:00:00Z",
    "2026-10-21T24:00:00Z",
    "2026-10-21T08:60:00Z",
    "2026-10-21T08:00:60Z",
    "2026-10-21T08:00:00+24:00",
    "2026-10-21T08:00:00+08:60",
    "2026-10-21T08:00:00Z trailing text",
    "2026-10-21T08:00:00",
    "2026-10-21",
  ])(
    "handles missing, invalid or timezone-free creation times: %s",
    (createdAt) => {
      expect(recordIdentity({ createdAt })).toBe("建立時間未記錄");
    },
  );

  it.each([
    ["2024-02-29T16:00:00.000Z", "2024/03/01 00:00:00"],
    ["2000-02-29T00:00:00Z", "2000/02/29 08:00:00"],
    ["2026-10-21T00:00:00+08:00", "2026/10/21 00:00:00"],
  ])(
    "formats valid leap days and Taipei midnight without a 24-hour rollover: %s",
    (createdAt, expected) => {
      expect(recordIdentity({ createdAt })).toBe(
        `建立 ${expected}（臺北時間）`,
      );
    },
  );

  it("converts an explicit non-UTC offset to Taipei and exposes the full record ID", () => {
    expect(recordIdentity({ createdAt: "2026-10-20T20:30:12-04:00" })).toBe(
      "建立 2026/10/21 08:30:12（臺北時間）",
    );
    const html = renderToStaticMarkup(
      createElement(MedicationIdentity, { medication: prescription }),
    );
    expect(html).toContain(`title="完整編號：${prescription.id}"`);
    expect(html).toContain("…12345678");
  });
});
