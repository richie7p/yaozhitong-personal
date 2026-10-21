import type { Drug, IdentityEvidence, IdentityReview } from "./schema.js";

/** Exact identity normalization preserves brands, flavors and all quantities. */
export const normalizeIdentityText = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
export const normalizeLicense = normalizeIdentityText;

const formAliases: Record<string, string> = {
  tablet: "錠",
  tablets: "錠",
  tab: "錠",
  tabs: "錠",
  錠: "錠",
  錠劑: "錠",
  capsule: "膠囊",
  capsules: "膠囊",
  膠囊: "膠囊",
  膠囊劑: "膠囊",
  syrup: "糖漿",
  糖漿: "糖漿",
  糖漿劑: "糖漿",
  cream: "乳膏",
  乳膏: "乳膏",
  乳膏劑: "乳膏",
  "film-coatedtablet": "膜衣錠",
  "film-coatedtablets": "膜衣錠",
  膜衣錠: "膜衣錠",
};
const exactForm = (value: string) => {
  const text = normalizeIdentityText(value);
  return formAliases[text] || text;
};
export interface IdentityInput {
  licenseNo?: string | null;
  candidateLicenseNo?: string | null;
  identityEvidence?: IdentityEvidence | null;
}

/** Built once per catalog snapshot; candidate search ranking never proves identity. */
export class ProductIdentityIndex {
  private licenses = new Map<string, Drug[]>();
  private names = new Map<string, Drug[]>();
  constructor(rows: Drug[]) {
    for (const row of rows) {
      const license = normalizeLicense(row.licenseNo);
      this.licenses.set(license, [...(this.licenses.get(license) || []), row]);
      for (const name of new Set(
        [row.nameZh, row.nameEn].map(normalizeIdentityText).filter(Boolean),
      ))
        this.names.set(name, [...(this.names.get(name) || []), row]);
    }
  }
  review(input: IdentityInput): IdentityReview {
    const selected = input.candidateLicenseNo || input.licenseNo;
    const selectedRows = selected
      ? this.licenses.get(normalizeLicense(selected)) || []
      : [];
    let candidate = selectedRows.length === 1 ? selectedRows[0] : null;
    const pending = (
      message: string,
      missingFields: string[],
    ): IdentityReview => ({
      status: "needs_information",
      message,
      missingFields,
      candidate,
    });
    const evidence = input.identityEvidence;
    if (!evidence)
      return pending(
        "請補拍能看清許可證的包裝，或另外抄錄完整品名、含量與劑型以核對產品。",
        ["identityEvidence"],
      );
    if (evidence.method === "license") {
      const license = normalizeLicense(evidence.printedLicenseNo);
      if (!license)
        return pending("請從包裝抄錄完整藥品許可證字號（包含前綴）。", [
          "printedLicenseNo",
        ]);
      const matches = this.licenses.get(license) || [];
      if (matches.length !== 1)
        return pending(
          "完整許可證未能唯一對上官方藥品，請核對字號或補拍清楚的包裝。",
          ["printedLicenseNo"],
        );
      if (
        selected &&
        (!candidate || candidate.licenseNo !== matches[0].licenseNo)
      )
        return pending("包裝許可證與所選候選藥不同，請重新選擇並核對。", [
          "candidateLicenseNo",
          "printedLicenseNo",
        ]);
      candidate = matches[0];
    } else if (evidence.method === "details") {
      if (candidate && !candidate.strength.trim())
        return pending(
          "官方資料未提供可核對的含量或規格，請補拍或抄錄包裝完整許可證。",
          ["printedLicenseNo"],
        );
      const missing = [
        ...(!evidence.printedName.trim() ? ["printedName"] : []),
        ...(!evidence.printedForm.trim() ? ["printedForm"] : []),
        ...(!evidence.printedStrength.trim() ? ["printedStrength"] : []),
      ];
      if (missing.length)
        return pending(
          "請另外抄錄包裝完整品名、含量與劑型；資料不足時請補拍許可證。",
          missing,
        );
      const matches = (
        this.names.get(normalizeIdentityText(evidence.printedName)) || []
      ).filter(
        (row) =>
          !!row.strength.trim() &&
          !!row.form.trim() &&
          normalizeIdentityText(row.strength) ===
            normalizeIdentityText(evidence.printedStrength) &&
          exactForm(row.form) === exactForm(evidence.printedForm),
      );
      if (
        matches.length !== 1 ||
        (selected &&
          (!candidate || candidate.licenseNo !== matches[0].licenseNo))
      )
        return pending(
          "完整品名、含量及劑型仍無法唯一核對所選產品，請補拍或抄錄完整許可證。",
          ["printedLicenseNo"],
        );
      candidate = matches[0];
    } else return pending("請選擇包裝資料的核對方式。", ["identityEvidence"]);
    // A saved partial draft may carry fields from both methods. Never discard
    // contradictory package text merely because another method was selected.
    if (
      evidence.printedLicenseNo.trim() &&
      normalizeLicense(evidence.printedLicenseNo) !==
        normalizeLicense(candidate.licenseNo)
    )
      return pending("已填的許可證與核對產品不同，請重新核對包裝資料。", [
        "printedLicenseNo",
      ]);
    if (
      (evidence.printedName.trim() &&
        ![candidate.nameZh, candidate.nameEn].some(
          (name) =>
            normalizeIdentityText(name) ===
            normalizeIdentityText(evidence.printedName),
        )) ||
      (evidence.printedStrength.trim() &&
        normalizeIdentityText(candidate.strength) !==
          normalizeIdentityText(evidence.printedStrength)) ||
      (evidence.printedForm.trim() &&
        exactForm(candidate.form) !== exactForm(evidence.printedForm))
    )
      return pending(
        "已填的品名、含量或劑型與核對產品不符，請重新核對包裝資料。",
        ["printedName", "printedStrength", "printedForm"],
      );
    return {
      status: "confirmed",
      message: "包裝資料已與官方藥品資料核對。",
      missingFields: [],
      candidate,
    };
  }
}
