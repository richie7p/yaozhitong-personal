import { describe, expect, it } from "vitest";
import { recognitionDraftFlags } from "../src/recognition-draft";

describe("conservative new-recognition frequency defaults", () => {
  it.each([
    "PRN",
    " prn ",
    "需要時",
    "需要時才服用",
    "需要時使用",
    "必要時",
    "必要時才使用",
    "必要時服用",
  ])("prefills explicit %s but still requires human confirmation", (frequency) => {
    expect(recognitionDraftFlags(frequency)).toEqual({
      prn: true,
      confirmed: false,
    });
  });

  it.each([
    null,
    undefined,
    "",
    "TID",
    "QD",
    "每日三次",
    "TID PRN",
    "每天三次，必要時使用",
    "PRN?",
    "可能需要時使用",
    "需要時才",
    "不是需要時使用",
    "疼痛時",
    "依指示服用",
    { rawText: "需要時才服用" },
  ])("does not guess from ambiguous or scheduled frequency %j", (frequency) => {
    expect(recognitionDraftFlags(frequency)).toEqual({
      prn: false,
      confirmed: false,
    });
  });
});
