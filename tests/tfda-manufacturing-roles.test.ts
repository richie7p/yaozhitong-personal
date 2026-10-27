import { describe, expect, it } from "vitest";
import { hasSingleOfficialManufacturingProduct, projectOfficialCatalogRows } from "../tools/tfda-manufacturing-roles";
import { evaluateTfdaSource, tfdaSourceHash, type TfdaSourceInput } from "../tools/tfda-source-core";

// Synthetic official-shaped rows only; no live sources or cloud/model requests.
const licenseNo = "衛部藥製字第999971號";
function rows() {
  const base = { 許可證字號: licenseNo, 中文品名: "合成角色測試錠5毫克", 英文品名: "SYNTHETIC ROLE TEST TABLETS 5MG",
    劑型: "合成錠劑", 有效日期: "2030/12/31", 註銷狀態: "", 藥品類別: "合成處方藥", 主成分略述: "SYNTHETIC 5MG",
    未來新增產品欄位: "必須逐字相同", 製程: "", 製造商名稱: "合成成品廠", 製造廠國別: "合成甲國", 製造廠廠址: "合成甲址", 製造廠公司地址: "合成總部甲" };
  return [base, { ...base, 製程: "二級包裝廠", 製造商名稱: "合成包裝廠", 製造廠國別: "合成乙國", 製造廠廠址: "合成乙址", 製造廠公司地址: "合成總部乙" }];
}
function input(): TfdaSourceInput {
  const original = rows(), text = original[0].中文品名 + "\n" + original[0].英文品名 + "\n" + licenseNo + "\n適應症\n" +
    "合成測試來源保留所有文字、條件與原始順序，不是醫療指示。".repeat(12);
  const source = "https://mcp.fda.gov.tw/synthetic/role-product.pdf";
  return { licenseNo, checkedAt: "2026-10-23T00:00:00Z", catalogCheckedAt: "2026-10-22T23:59:00Z", indexCheckedAt: "2026-10-22T23:59:00Z",
    catalogRows: projectOfficialCatalogRows(original), catalogManufacturingRecords: original,
    indexRows: [{ licenseNo, nameZh: original[0].中文品名, nameEn: original[0].英文品名, urls: [source] }],
    fetched: { requestedUrl: source, finalUrl: source, retrievedAt: "2026-10-22T23:59:00Z", sha256: tfdaSourceHash("synthetic raw"), bytes: 1000, mediaType: "application/pdf", contentSignature: "pdf" },
    format: "pdf", numPages: 1, pages: [{ page: 1, text, independentText: text, embeddedImages: 0, hasLargeUnverifiedImage: false, hasUnverifiedStructure: false }] };
}
describe("official manufacturing-role product identity", () => {
  it("coalesces only one identical official product while retaining every role row", () => {
    const candidate = input(), result = evaluateTfdaSource(candidate);
    expect(result.eligibleTechnical).toBe(true);
    expect(result.evidence.coalescedProductCount).toBe(1);
    expect(result.evidence.catalogManufacturingRecords).toEqual(candidate.catalogManufacturingRecords);
    expect(result.warnings).toContain("official_manufacturing_roles_preserved_not_unique_factory");
    expect(candidate.catalogRows).toHaveLength(2);
  });
  it("keeps legacy multi-factory inputs held without complete role evidence", () => {
    const candidate = input(); delete candidate.catalogManufacturingRecords;
    expect(evaluateTfdaSource(candidate).reasons).toContain("catalog_product_ambiguous");
  });
  it.each(["許可證字號", "中文品名", "英文品名", "劑型", "有效日期", "註銷狀態", "藥品類別", "主成分略述", "未來新增產品欄位"])("retains review for a literal difference in %s", (field) => {
    const original = rows(); (original[1] as Record<string, string>)[field] += "不同";
    expect(hasSingleOfficialManufacturingProduct(licenseNo, projectOfficialCatalogRows(original), original)).toBe(false);
  });
  it("does not normalize away a non-role difference or missing unknown field", () => {
    const original = rows(); original[1].主成分略述 += " ";
    expect(hasSingleOfficialManufacturingProduct(licenseNo, projectOfficialCatalogRows(original), original)).toBe(false);
    const changed = rows(); delete (changed[1] as Record<string, unknown>).未來新增產品欄位;
    expect(hasSingleOfficialManufacturingProduct(licenseNo, projectOfficialCatalogRows(changed), changed)).toBe(false);
  });
  it("preserves official null fields literally and rejects null-versus-empty differences", () => {
    const original: Record<string, string | null>[] = rows().map((row) => ({ ...row, 註銷日期: null, 包裝與國際條碼: null }));
    expect(hasSingleOfficialManufacturingProduct(licenseNo, projectOfficialCatalogRows(original), original)).toBe(true);
    original[1].包裝與國際條碼 = "";
    expect(hasSingleOfficialManufacturingProduct(licenseNo, projectOfficialCatalogRows(original), original)).toBe(false);
  });
  it("requires at least one explicit role and a nonempty manufacturer in every row", () => {
    for (const blank of ["role", "manufacturer"]) {
      const original = rows();
      if (blank === "role") original[1].製程 = ""; else original[1].製造商名稱 = "";
      expect(hasSingleOfficialManufacturingProduct(licenseNo, projectOfficialCatalogRows(original), original)).toBe(false);
    }
  });
  it("rejects caller projections that omit, reorder, or alter original official rows", () => {
    const original = rows(), projected = projectOfficialCatalogRows(original);
    for (const changed of [projected.slice(0, 1), [...projected].reverse(), [{ ...projected[0], nameZh: "別的產品" }, projected[1]]])
      expect(hasSingleOfficialManufacturingProduct(licenseNo, changed, original)).toBe(false);
  });
  it("keeps source completeness, current identity, and raw-material gates unchanged", () => {
    const candidate = input(); candidate.officialCategory = "製劑原料";
    candidate.pages[0].independentText = "合成不完整抽取";
    const result = evaluateTfdaSource(candidate);
    expect(result.eligibleTechnical).toBe(false);
    expect(result.reasons).toContain("raw_material_source_not_patient_leaflet");
    expect(result.reasons).toContain("independent_ordered_text_mismatch");
  });
});
