import { describe, expect, it } from "vitest";
import { scoreDrug } from "../server/catalog";
import type { Drug } from "../shared/schema";

const tablet: Drug = {
  licenseNo: "SYNTHETIC-CATALOG",
  nameZh: "「合成廠」測試錠200毫克(合成甲)",
  nameEn: 'SYNTHETIC TABLETS 200MG "MAKER" (FIXTURE A)',
  strength: "200毫克",
  form: "錠劑",
  ingredients: ["SYNTHETIC A"],
  revoked: false,
};
const splitName = "「合成廠」測試錠（合成甲）";

describe("conservative name matching with a separately transcribed strength", () => {
  it.each(["200毫克", "200mg", "200 MG", "２００ｍｇ"])(
    "matches a complete split title with the same explicit %s",
    (strength) => {
      expect(scoreDrug(tablet, splitName, strength, "錠")).toBe(165);
    },
  );
  it("accepts matching single strength explicitly present in the official title or metadata", () => {
    expect(
      scoreDrug({ ...tablet, strength: "" }, splitName, "200mg", "錠"),
    ).toBe(165);
    expect(
      scoreDrug(
        { ...tablet, nameZh: splitName },
        "「合成廠」測試錠200mg（合成甲）",
        "200mg",
        "錠",
      ),
    ).toBe(165);
    expect(
      scoreDrug(tablet, 'SYNTHETIC TABLETS "MAKER" (FIXTURE A)', "200mg", "錠"),
    ).toBe(165);
  });
  it.each(["20mg", "400毫克"])(
    "rejects explicit %s conflicts even for an exact title",
    (strength) => {
      expect(scoreDrug(tablet, splitName, strength, "錠")).toBe(0);
      expect(scoreDrug(tablet, tablet.nameZh, strength, "錠")).toBe(0);
    },
  );
  it("rejects disagreement between supplied, title and metadata strengths", () => {
    expect(
      scoreDrug(tablet, "「合成廠」測試錠20mg（合成甲）", "200mg", "錠"),
    ).toBe(0);
    expect(
      scoreDrug({ ...tablet, strength: "400mg" }, splitName, "200mg", "錠"),
    ).toBe(0);
    expect(
      scoreDrug(
        { ...tablet, nameEn: tablet.nameEn.replace("200MG", "400MG") },
        splitName,
        "200mg",
        "錠",
      ),
    ).toBe(0);
  });
  it("does not discard an ingredient qualifier or a different dosage form", () => {
    expect(scoreDrug(tablet, "「合成廠」測試錠（合成乙）", "200mg", "錠")).toBe(
      0,
    );
    expect(scoreDrug(tablet, "「合成廠」測試錠", "200mg", "錠")).toBeLessThan(
      165,
    );
    expect(scoreDrug(tablet, splitName, "200mg", "膠囊")).toBe(0);
    expect(
      scoreDrug(tablet, "「合成廠」測試膠囊（合成甲）", "200mg", "膠囊"),
    ).toBe(0);
  });
  it("requires a supplied single strength and never guesses a concentration or converts units", () => {
    for (const strength of ["", "0.2g", "200mg/5ml", "200mg+5mg", "200"])
      expect(scoreDrug(tablet, splitName, strength, "錠")).toBe(0);
    expect(
      scoreDrug(
        {
          ...tablet,
          nameZh: "「合成廠」測試錠200mg/5ml(合成甲)",
          strength: "200mg",
        },
        splitName,
        "200mg",
        "錠",
      ),
    ).toBe(0);
  });
  it("does not add aliases for combination products, multiple strengths or ambiguous metadata", () => {
    expect(
      scoreDrug(
        { ...tablet, ingredients: ["SYNTHETIC A", "SYNTHETIC B"] },
        splitName,
        "200mg",
        "錠",
      ),
    ).toBe(0);
    expect(
      scoreDrug(
        { ...tablet, nameZh: "「合成廠」測試錠200mg加5mg(合成甲)" },
        splitName,
        "200mg",
        "錠",
      ),
    ).toBe(0);
    expect(
      scoreDrug({ ...tablet, strength: "每錠200mg" }, splitName, "200mg", "錠"),
    ).toBe(0);
  });
  it("keeps brand numbers such as B12 as part of the full identity", () => {
    const brand = {
      ...tablet,
      nameZh: "合成B12測試錠200mg(合成甲)",
      nameEn: "",
      strength: "200mg",
    };
    expect(scoreDrug(brand, "合成B12測試錠（合成甲）", "200mg", "錠")).toBe(
      165,
    );
    expect(scoreDrug(brand, "合成測試錠（合成甲）", "200mg", "錠")).toBe(0);
    expect(
      scoreDrug(
        { ...brand, nameZh: "合成B12測試錠(合成甲)", strength: "" },
        "合成測試錠（合成甲）",
        "12mg",
        "錠",
      ),
    ).toBe(0);
  });
  it("preserves valid exact, prefix, license and revoked ordering", () => {
    expect(scoreDrug(tablet, tablet.nameZh, "200毫克", "錠")).toBe(180);
    expect(scoreDrug(tablet, tablet.nameZh)).toBe(100);
    expect(scoreDrug(tablet, "「合成廠」測試")).toBe(60);
    expect(scoreDrug(tablet, tablet.licenseNo)).toBe(150);
    expect(
      scoreDrug({ ...tablet, revoked: true }, tablet.nameZh, "200毫克", "錠"),
    ).toBe(160);
    expect(scoreDrug(tablet, tablet.nameZh, "200毫克", "錠")).toBeGreaterThan(
      scoreDrug(tablet, splitName, "200mg", "錠"),
    );
  });
});

describe("conservative bilingual brand candidates", () => {
  const bilingual: Drug = {
    licenseNo: "SYNTHETIC-BILINGUAL",
    nameZh: "合成B12錠80毫克",
    nameEn: "SYNTHB12 TABLETS 80MG",
    strength: "80毫克",
    form: "錠劑",
    ingredients: ["SYNTHETIC A"],
    revoked: false,
  };
  it.each(["SYNTHB12 合成B12", "合成B12 SYNTHB12", "SYNTHB12合成B12"])(
    "matches both complete brand prefixes in %s below exact titles",
    (query) => {
      expect(scoreDrug(bilingual, query, "80mg", "錠劑")).toBe(165);
      expect(scoreDrug(bilingual, bilingual.nameZh, "80mg", "錠劑")).toBe(180);
    },
  );
  it("keeps per-tablet notation non-equivalent and a lower-ranked manual candidate", () => {
    expect(scoreDrug(bilingual, "SYNTHB12 合成B12", "80mg/tab", "錠劑")).toBe(
      35,
    );
    expect(scoreDrug(bilingual, bilingual.nameZh, "80mg/tab", "錠劑")).toBe(50);
  });
  it.each(["20mg", "500mg", "20mg/tab", "500mg/tab"])(
    "rejects the explicit conflicting strength %s",
    (strength) => {
      expect(scoreDrug(bilingual, "SYNTHB12 合成B12", strength, "錠劑")).toBe(
        0,
      );
    },
  );
  it.each(["80mg/ml", "80mg/g", "80mg/5ml", "80%"])(
    "does not drop a concentration denominator or percent in %s",
    (strength) => {
      expect(scoreDrug(bilingual, "SYNTHB12 合成B12", strength, "錠劑")).toBe(
        0,
      );
    },
  );
  it.each([
    "SYNTH 合成B12",
    "SYNTHB12 合成",
    "OTHER 合成B12",
    "SYNTHB12 別牌B12",
    "SYNTHB12 合成B12膠囊",
    "SYNTHB12 CAPSULES 合成B12",
    "SYNTHB12 合成B12(其他成分)",
    "SYNTHB12 EXTRA 合成B12",
  ])("does not discard a differing identity in %s", (query) => {
    expect(scoreDrug(bilingual, query, "80mg", "錠劑")).toBe(0);
  });
  it("does not give the bilingual alias score to one language alone", () => {
    expect(scoreDrug(bilingual, "SYNTHB12", "80mg", "錠劑")).toBe(140);
    expect(scoreDrug(bilingual, "合成B12", "80mg", "錠劑")).toBe(140);
  });
  it("rejects an explicit title strength conflict even with per-tablet metadata", () => {
    expect(
      scoreDrug(bilingual, "SYNTHB12 TABLETS 20MG 合成B12", "80mg/tab", "錠劑"),
    ).toBe(0);
    expect(
      scoreDrug(bilingual, "SYNTHB12 合成B12錠500毫克", "80mg/tab", "錠劑"),
    ).toBe(0);
  });
  it("keeps official ingredient qualifiers, dosage forms and concentration intact", () => {
    expect(
      scoreDrug(
        { ...bilingual, nameZh: bilingual.nameZh + "(合成甲)" },
        "SYNTHB12 合成B12",
        "80mg",
        "錠劑",
      ),
    ).toBe(0);
    expect(scoreDrug(bilingual, "SYNTHB12 合成B12", "80mg", "膠囊")).toBe(0);
    expect(
      scoreDrug(
        {
          ...bilingual,
          strength: "80mg/ml",
          nameZh: "合成B12滴劑80mg/ml",
          nameEn: "SYNTHB12 DROPS 80MG/ML",
          form: "滴劑",
        },
        "SYNTHB12 合成B12",
        "80mg",
        "滴劑",
      ),
    ).toBe(0);
  });
});
