import { describe, expect, it } from "vitest";
import { Catalog, scoreDrug } from "../server/catalog";
import type { Drug } from "../shared/schema";
import { MemoryStore } from "../server/store";
import type { Blobs } from "../server/blobs";

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

describe("actual public-photo candidate regressions", () => {
  // Exact entries from the reviewed 66,511-row official catalog. These remain
  // candidates for explicit selection; the photo does not prove a license.
  const secorine: Drug = {
    licenseNo: "衛署藥製字第040833號",
    nameZh: '"晟德"息咳寧糖漿',
    nameEn: 'SECORINE SYRUP "CENTER"',
    strength: "",
    form: "糖漿劑",
    ingredients: [
      "DL-METHYLEPHEDRINE HCL",
      "DL-METHYLEPHEDRINE HCL",
      "CHLORPHENIRAMINE MALEATE",
      "CHLORPHENIRAMINE MALEATE",
      "GUAIACOL GLYCOLATE (EQ TO GLYCERYL GUAIACOLATE)",
      "GUAIACOL GLYCOLATE (EQ TO GLYCERYL GUAIACOLATE)",
    ],
    revoked: false,
  };
  const kentamin: Drug = {
    licenseNo: "衛署藥製字第014025號",
    nameZh: "開恩達命膠囊",
    nameEn: "KENTAMIN CAPSULES",
    strength: "",
    form: "膠囊劑",
    ingredients: [
      "THIAMINE MONONITRATE",
      "CYANOCOBALAMIN (VIT B12)",
      "PYRIDOXINE HCL",
    ],
    revoked: false,
  };
  const photographedKentamin =
    "Kentamin（Thiamine & Pyridoxine & Cyanocobalamin）";
  it.each([
    {
      attempt: "cathay-secorine-1",
      drug: secorine,
      name: "Secorine syrup",
      form: "液劑",
      score: 90,
    },
    {
      attempt: "cathay-secorine-2",
      drug: secorine,
      name: "Secorine syrup",
      form: "液劑",
      score: 90,
    },
    {
      attempt: "tzuchi-kentamin-full-flow-1",
      drug: kentamin,
      name: photographedKentamin,
      form: "",
      score: 85,
    },
    {
      attempt: "tzuchi-kentamin-full-flow-2",
      drug: kentamin,
      name: photographedKentamin,
      form: "",
      score: 85,
    },
  ])(
    "finds the official candidate for original $attempt without adding strength",
    (row) => {
      expect(scoreDrug(row.drug, row.name, "", row.form)).toBe(row.score);
      expect(row.drug.strength).toBe("");
    },
  );
  it.each(["Syrup", "糖漿", "糖漿劑", "液劑", "內服液劑", "口服液劑"])(
    "accepts %s for an explicitly named syrup without merging oral solutions",
    (form) => {
      expect(scoreDrug(secorine, "Secorine syrup", "", form)).toBe(90);
      expect(
        scoreDrug(
          { ...secorine, form: "內服液劑" },
          "Secorine syrup",
          "",
          form,
        ),
      ).toBe(90);
    },
  );
  it("requires explicit syrup identity before interpreting a generic liquid form", () => {
    expect(scoreDrug(secorine, "Secorine", "", "液劑")).toBe(0);
    const solution = {
      ...secorine,
      nameZh: "合成口服液",
      nameEn: "SYNTHETIC SOLUTION",
      form: "內服液劑",
    };
    expect(scoreDrug(solution, solution.nameEn, "", "Syrup")).toBe(0);
    expect(scoreDrug(solution, solution.nameEn, "", "糖漿劑")).toBe(0);
    expect(
      scoreDrug(
        { ...secorine, form: "注射液劑" },
        "Secorine syrup",
        "",
        "液劑",
      ),
    ).toBe(0);
  });
  it.each(["Capsule", "Capsules", "膠囊", "膠囊劑"])(
    "accepts the known capsule alias %s with all three matching ingredients",
    (form) =>
      expect(scoreDrug(kentamin, photographedKentamin, "", form)).toBe(115),
  );
  it("preserves original tablet strength and its denominator with English form aliases", () => {
    expect(scoreDrug(tablet, tablet.nameZh, "200mg", "Tablets")).toBe(180);
    expect(scoreDrug(tablet, splitName, "200mg/tab", "Tablet")).toBe(0);
    expect(scoreDrug(tablet, tablet.nameZh, "20mg", "Tablets")).toBe(0);
  });
  it.each(["錠劑", "乳膏劑", "注射液劑", "外用液劑"])(
    "rejects incompatible %s instead of letting the name score outweigh it",
    (form) => {
      expect(scoreDrug(secorine, "Secorine syrup", "", form)).toBe(0);
      expect(scoreDrug(kentamin, photographedKentamin, "", form)).toBe(0);
      expect(scoreDrug(kentamin, kentamin.nameEn, "", form)).toBe(0);
    },
  );
  it.each([
    "Kenta（Thiamine & Pyridoxine & Cyanocobalamin）",
    "Kentamin Extra（Thiamine & Pyridoxine & Cyanocobalamin）",
    "Kentamin（Thiamine & Pyridoxine）",
    "Kentamin（Thiamine & Pyridoxine & Folic Acid）",
    "Kentamin（Thiamine & Pyridoxine & Cyanocobalamin & Folic Acid）",
    "Kentamin（Thiamine & Thiamine & Cyanocobalamin）",
    "Kentamin（Thiamine 50mg & Pyridoxine & Cyanocobalamin）",
  ])(
    "does not discard an incomplete or conflicting identity in %s",
    (query) => {
      expect(scoreDrug(kentamin, query)).toBe(0);
    },
  );
  it("rejects official extra qualifiers and any supplied unknown strength", () => {
    expect(
      scoreDrug(
        { ...kentamin, nameEn: "KENTAMIN CAPSULES EXTRA" },
        photographedKentamin,
      ),
    ).toBe(0);
    expect(
      scoreDrug(
        { ...kentamin, nameEn: "KENTAMIN CAPSULES 50MG" },
        photographedKentamin,
      ),
    ).toBe(0);
    for (const strength of [
      "50mg",
      "50mg/tab",
      "50mg/ml",
      "500mcg",
      "50mg+500mcg",
    ])
      expect(scoreDrug(kentamin, photographedKentamin, strength)).toBe(0);
    for (const strength of ["1mg", "1mg/ml", "0.1mg/ml"])
      expect(
        scoreDrug(secorine, "Secorine syrup", strength, "液劑"),
      ).toBeLessThanOrEqual(0);
  });
  it("lists the current Secorine license before the revoked exact-name record", async () => {
    const oldSecorine: Drug = {
      ...secorine,
      licenseNo: "內衛藥製字第003544號",
      nameZh: "息咳/糖漿",
      nameEn: "SECORINE SYRUP",
      revoked: true,
    };
    const store = new MemoryStore();
    await store.set("settings", "catalog", {
      version: "secorine-order",
      path: "catalog/secorine-order.json",
    });
    const blobs = {
      get: async () => Buffer.from(JSON.stringify([oldSecorine, secorine])),
    } as unknown as Blobs;
    const catalog = new Catalog(store, blobs);
    const results = await catalog.search("Secorine syrup", "", "液劑");
    expect(results.map((row) => row.licenseNo)).toEqual([
      "衛署藥製字第040833號",
      "內衛藥製字第003544號",
    ]);
    expect(results[0].score).toBeLessThan(results[1].score);
    expect(results[1].revoked).toBe(true);
  });
  it("retains score order within each current or revoked candidate group", async () => {
    const currentExact = {
      ...secorine,
      licenseNo: "CURRENT-EXACT",
      nameEn: "SECORINE SYRUP",
    };
    const currentPrefix = { ...secorine, licenseNo: "CURRENT-PREFIX" };
    const revokedExact = {
      ...currentExact,
      licenseNo: "REVOKED-EXACT",
      revoked: true,
    };
    const revokedPrefix = {
      ...currentPrefix,
      licenseNo: "REVOKED-PREFIX",
      revoked: true,
    };
    const rows = [revokedPrefix, currentPrefix, revokedExact, currentExact];
    const store = new MemoryStore();
    await store.set("settings", "catalog", {
      version: "group-order",
      path: "catalog/group-order.json",
    });
    const blobs = {
      get: async () => Buffer.from(JSON.stringify(rows)),
    } as unknown as Blobs;
    const catalog = new Catalog(store, blobs);
    const results = await catalog.search("Secorine syrup", "", "液劑");
    expect(results.map((row) => row.licenseNo)).toEqual([
      "CURRENT-EXACT",
      "CURRENT-PREFIX",
      "REVOKED-EXACT",
      "REVOKED-PREFIX",
    ]);
    expect(results).toHaveLength(4);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[2].score).toBeGreaterThan(results[3].score);
  });
});
