import { describe, expect, it } from "vitest";
import { ProductIdentityIndex } from "../shared/product-identity";
import { IdentityEvidenceSchema, type Drug } from "../shared/schema";

const syrup: Drug = {
  licenseNo: "衛部藥製字第000001號",
  nameZh: "合成息咳寧柳橙糖漿",
  nameEn: "Synthetic Secorine Orange Syrup",
  strength: "5mg/5mL",
  form: "糖漿劑",
  ingredients: ["synthetic"],
  revoked: false,
};
const evidence = (
  values: Partial<ReturnType<typeof IdentityEvidenceSchema.parse>>,
) => IdentityEvidenceSchema.parse({ method: "details", ...values });
const details = () =>
  evidence({
    printedName: syrup.nameEn,
    printedStrength: syrup.strength,
    printedForm: "syrup",
  });

describe("independent package evidence for product identity", () => {
  it("never promotes a candidate, brand-only syrup label or forged status to proof", () => {
    const index = new ProductIdentityIndex([syrup]);
    expect(index.review({ candidateLicenseNo: syrup.licenseNo }).status).toBe(
      "needs_information",
    );
    expect(
      index.review({
        candidateLicenseNo: syrup.licenseNo,
        identityEvidence: evidence({
          printedName: "Secorine",
          printedForm: "syrup",
        }),
      }).status,
    ).toBe("needs_information");
    expect(
      index.review({
        candidateLicenseNo: syrup.licenseNo,
        ...{ identityReview: { status: "confirmed" } },
      }).status,
    ).toBe("needs_information");
  });
  it("requires the complete license prefix and preserves the selected candidate", () => {
    const index = new ProductIdentityIndex([
      syrup,
      { ...syrup, licenseNo: "衛署藥輸字第000001號" },
    ]);
    expect(
      index.review({
        candidateLicenseNo: syrup.licenseNo,
        identityEvidence: evidence({
          method: "license",
          printedLicenseNo: "000001",
        }),
      }).status,
    ).toBe("needs_information");
    expect(
      index.review({
        candidateLicenseNo: syrup.licenseNo,
        identityEvidence: evidence({
          method: "license",
          printedLicenseNo: "衛署藥輸字第000001號",
        }),
      }).status,
    ).toBe("needs_information");
    expect(
      index.review({
        identityEvidence: evidence({
          method: "license",
          printedLicenseNo: " 衛部藥製字 第０００００１號 ",
        }),
      }),
    ).toMatchObject({ status: "confirmed", candidate: syrup });
  });
  it("accepts only complete unique names, exact known strength, and conservative form aliases", () => {
    const index = new ProductIdentityIndex([syrup]);
    expect(index.review({ identityEvidence: details() }).status).toBe(
      "confirmed",
    );
    for (const change of [
      { printedName: "Synthetic Secorine Syrup" },
      { printedName: "Synthetic Secorine Strawberry Syrup" },
      { printedStrength: "" },
      { printedStrength: "1mg/mL" },
      { printedForm: "液劑" },
      { printedForm: "口服液劑" },
    ])
      expect(
        index.review({
          candidateLicenseNo: syrup.licenseNo,
          identityEvidence: { ...details(), ...change },
        }).status,
      ).toBe("needs_information");
    expect(
      index.review({
        identityEvidence: { ...details(), printedStrength: "５ mg / ５ mL" },
      }).status,
    ).toBe("confirmed");
  });
  it("does not use ranking, top twelve limits, or leaflet availability to choose duplicate English names", () => {
    const rows = [
      syrup,
      ...Array.from({ length: 12 }, (_, i) => ({
        ...syrup,
        licenseNo: `unrelated-${i}`,
        nameZh: `別藥${i}`,
        nameEn: `Unrelated ${i}`,
      })),
      { ...syrup, licenseNo: "other-manufacturer", nameZh: "別廠合成糖漿" },
    ];
    expect(
      new ProductIdentityIndex(rows).review({
        candidateLicenseNo: syrup.licenseNo,
        identityEvidence: details(),
      }).status,
    ).toBe("needs_information");
  });
  it("requires known official strength for details even without a selected candidate", () => {
    const unknown = { ...syrup, strength: "" };
    const index = new ProductIdentityIndex([unknown]);
    for (const printedStrength of ["", syrup.strength])
      expect(
        index.review({ identityEvidence: { ...details(), printedStrength } })
          .status,
      ).toBe("needs_information");
    expect(
      index.review({
        identityEvidence: evidence({
          method: "license",
          printedLicenseNo: unknown.licenseNo,
        }),
      }).status,
    ).toBe("confirmed");
  });
  it("directs a selected same-brand product with unknown strength to complete license evidence", () => {
    const unknown = { ...syrup, licenseNo: "unknown-strength", strength: "" };
    const index = new ProductIdentityIndex([syrup, unknown]);
    for (const printedStrength of ["", syrup.strength])
      expect(
        index.review({
          candidateLicenseNo: unknown.licenseNo,
          identityEvidence: { ...details(), printedStrength },
        }),
      ).toMatchObject({
        status: "needs_information",
        missingFields: ["printedLicenseNo"],
        candidate: unknown,
      });
  });
  it("keeps brand/flavor modifiers and can disambiguate unique exact Chinese names", () => {
    const index = new ProductIdentityIndex([
      syrup,
      {
        ...syrup,
        licenseNo: "strawberry",
        nameZh: "合成息咳寧草莓糖漿",
        nameEn: "Synthetic Secorine Strawberry Syrup",
      },
    ]);
    expect(
      index.review({
        identityEvidence: { ...details(), printedName: syrup.nameZh },
      }),
    ).toMatchObject({ status: "confirmed", candidate: syrup });
  });
  it("rejects contradictions retained from the other evidence method", () => {
    const index = new ProductIdentityIndex([syrup]);
    expect(
      index.review({
        identityEvidence: { ...details(), printedLicenseNo: "wrong" },
      }).status,
    ).toBe("needs_information");
    expect(
      index.review({
        identityEvidence: evidence({
          method: "license",
          printedLicenseNo: syrup.licenseNo,
          printedStrength: "10mg/5mL",
        }),
      }).status,
    ).toBe("needs_information");
  });
  it("allows partial evidence drafts with bounded text", () => {
    expect(
      IdentityEvidenceSchema.parse({ method: "details", printedName: "部分" })
        .printedStrength,
    ).toBe("");
    expect(
      IdentityEvidenceSchema.safeParse({
        method: "details",
        printedName: "x".repeat(251),
      }).success,
    ).toBe(false);
  });
});
