import type { TfdaCatalogProduct } from "./tfda-source-core.js";
export type OfficialCatalogManufacturingRecord = Record<string, string | null>;

/** InfoId36 lists one product once for each manufacturing/packaging role. */
const manufacturingFields = new Set([
  "製程", "製造商名稱", "製造廠國別", "製造廠廠址", "製造廠公司地址",
]);

export function projectOfficialCatalogRows(records: Record<string, unknown>[]): TfdaCatalogProduct[] {
  return records.map((row) => ({
    licenseNo: String(row["許可證字號"] || ""), nameZh: String(row["中文品名"] || ""),
    nameEn: String(row["英文品名"] || ""), form: String(row["劑型"] || ""),
    manufacturer: String(row["製造商名稱"] || ""), effectiveUntil: String(row["有效日期"] || ""),
    revoked: !!String(row["註銷狀態"] || "").trim(),
  }));
}

/**
 * Only factory metadata may vary. Every other official field, including fields
 * unknown to this program, must be literally identical. A nonempty official
 * process role is required; no factory is inferred to be the sole manufacturer.
 * Publication separately binds every raw row to its frozen InfoId36 bytes.
 */
export function hasSingleOfficialManufacturingProduct(
  licenseNo: string,
  projected: TfdaCatalogProduct[],
  records: unknown,
): records is OfficialCatalogManufacturingRecord[] {
  if (!Array.isArray(records) || records.length < 2 || records.length > 100 || records.length !== projected.length)
    return false;
  if (records.some((row) => !row || typeof row !== "object" || Array.isArray(row) ||
    Object.values(row).some((value) => value !== null && typeof value !== "string") ||
    row["許可證字號"] !== licenseNo || !row["製造商名稱"]?.trim())) return false;
  const keys = Object.keys(records[0]).sort();
  if (!["許可證字號", "中文品名", "英文品名", "劑型", "有效日期", "註銷狀態", "製程", "製造商名稱"].every((key) => keys.includes(key)))
    return false;
  if (records.some((row) => JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(keys))) return false;
  if (!records.some((row) => typeof row["製程"] === "string" && row["製程"].trim())) return false;
  if (records.some((row) => keys.some((key) => !manufacturingFields.has(key) && row[key] !== records[0][key]))) return false;
  const actual = projectOfficialCatalogRows(records);
  return actual.every((row, i) => Object.keys(row).every((key) =>
    row[key as keyof TfdaCatalogProduct] === projected[i]?.[key as keyof TfdaCatalogProduct]) &&
    Object.keys(projected[i]).length === Object.keys(row).length);
}
