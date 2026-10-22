/** Fixed three-source correction. No network, account data, models or blob operations. */
import {
  TFDA_PUBLICATION_ACTOR, TFDA_PROTECTED_LICENSES, publicationHash,
  publicationRequire as must, sameDocument, technicalAuditId, type PublicationDoc,
} from "./tfda-publication-core.js";
import { normalizeTfdaSourceText } from "./tfda-source-core.js";

export const RAW_MATERIAL_WITHDRAWAL_ACTOR = "tfda-official-category-correction-not-clinical";
export const RAW_MATERIAL_WITHDRAWAL_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  "衛署藥製字第055117號": "原料藥",
  "衛署藥製字第055581號": "原料藥",
  "衛署藥製字第057411號": "製劑原料",
});
export interface WithdrawalBefore { pointer: PublicationDoc; leaflet: PublicationDoc; publicationAudit: PublicationDoc }
export interface WithdrawalEntry { licenseNo: string; officialCategory: string; before: WithdrawalBefore }
export interface WithdrawalRun { runId: string; snapshotSha256: string; catalogSha256: string }
export interface WithdrawalTx {
  get(collection: string, id: string): Promise<PublicationDoc | null>;
  set(collection: string, id: string, value: PublicationDoc): void;
  create(collection: string, id: string, value: PublicationDoc): void;
  delete(collection: string, id: string): void;
}
export interface WithdrawalStore { transaction<T>(operation: (tx: WithdrawalTx) => Promise<T>): Promise<T> }

export function officialWithdrawalCategory(rows: PublicationDoc[], licenseNo: string): string {
  must(Object.hasOwn(RAW_MATERIAL_WITHDRAWAL_TARGETS, licenseNo) &&
    !(TFDA_PROTECTED_LICENSES as readonly string[]).includes(licenseNo), "withdrawal_target_not_one_of_fixed_three");
  const selected = rows.filter((row) => row["許可證字號"] === licenseNo);
  must(selected.length > 0 && selected.every((row) => typeof row["藥品類別"] === "string" &&
    normalizeTfdaSourceText(row["藥品類別"]) === RAW_MATERIAL_WITHDRAWAL_TARGETS[licenseNo]), "withdrawal_current_official_category_mismatch");
  return RAW_MATERIAL_WITHDRAWAL_TARGETS[licenseNo];
}
export function validateWithdrawalEntry(entry: WithdrawalEntry, rows: PublicationDoc[]) {
  must(entry.officialCategory === officialWithdrawalCategory(rows, entry.licenseNo), "withdrawal_snapshot_category_mismatch");
  const { pointer, leaflet, publicationAudit } = entry.before;
  const marker = leaflet?.sourceImport;
  must(pointer && leaflet && publicationAudit && leaflet.licenseNo === entry.licenseNo && leaflet.status === "published" &&
    /^[a-f0-9]{64}$/.test(leaflet.sha256 || "") && leaflet.id === publicationHash(entry.licenseNo + "|" + leaflet.sha256) &&
    leaflet.version === leaflet.sha256.slice(0, 16) && pointer.leafletId === leaflet.id && pointer.version === leaflet.version,
    "withdrawal_original_source_or_pointer_inconsistent");
  must(leaflet.checkedBy === TFDA_PUBLICATION_ACTOR && leaflet.checkedAt === marker?.at &&
    typeof marker?.runId === "string" && !!marker.runId && typeof marker.batchId === "string" && !!marker.batchId &&
    /^[a-f0-9]{64}$/.test(marker.manifestSha256 || "") && /^[a-f0-9]{64}$/.test(marker.snapshotSha256 || "") &&
    Number.isFinite(Date.parse(marker.at)) && sameDocument(pointer.sourceImport, marker), "withdrawal_not_owned_by_technical_import");
  must(leaflet.sourceVerification?.actor === TFDA_PUBLICATION_ACTOR && leaflet.sourceVerification?.humanReviewed === false &&
    leaflet.sourceVerification?.clinicalReviewed === false && leaflet.sourceVerification?.rawSourceSha256 === leaflet.sha256,
    "withdrawal_nonautomated_or_unverified_source_forbidden");
  must(publicationAudit.id === technicalAuditId(marker.runId, leaflet.id) && publicationAudit.actor === TFDA_PUBLICATION_ACTOR &&
    publicationAudit.action === "leaflet.technical_source_publish" && publicationAudit.target === leaflet.id &&
    publicationAudit.at === marker.at && publicationAudit.clinicalReviewed === false &&
    sameDocument(publicationAudit.sourceImport, marker), "withdrawal_original_publication_audit_mismatch");
}
export function withdrawalAuditId(run: WithdrawalRun, licenseNo: string, restore = false) {
  return publicationHash(`${run.snapshotSha256}|${licenseNo}|${restore ? "restore" : "withdraw"}`);
}
function withdrawalAudit(entry: WithdrawalEntry, run: WithdrawalRun, at: string, restore = false) {
  return { id: withdrawalAuditId(run, entry.licenseNo, restore), actor: RAW_MATERIAL_WITHDRAWAL_ACTOR,
    action: restore ? "leaflet.raw_material_withdrawal.restore" : "leaflet.withdraw_official_raw_material_category",
    target: entry.before.leaflet.id, fullLicense: entry.licenseNo, at, ...run,
    sourceImport: entry.before.leaflet.sourceImport,
    officialCategory: entry.officialCategory, reason: "official_raw_material_not_patient_leaflet", clinicalReviewed: false };
}
function retired(entry: WithdrawalEntry, run: WithdrawalRun, at: string): PublicationDoc {
  return { ...entry.before.leaflet, status: "retired", sourceWithdrawal: {
    ...run, at, actor: RAW_MATERIAL_WITHDRAWAL_ACTOR, reason: "official_raw_material_not_patient_leaflet",
    officialCategory: entry.officialCategory,
  } };
}
export async function applyRawMaterialWithdrawal(store: WithdrawalStore, entry: WithdrawalEntry, rows: PublicationDoc[],
  run: WithdrawalRun, mode: "withdraw" | "restore", timestamp = new Date().toISOString()) {
  validateWithdrawalEntry(entry, rows);
  must(!!run.runId && /^[a-f0-9]{64}$/.test(run.snapshotSha256) && /^[a-f0-9]{64}$/.test(run.catalogSha256) &&
    Number.isFinite(Date.parse(timestamp)), "withdrawal_run_or_timestamp_invalid");
  const pointerId = publicationHash(entry.licenseNo), leafletId = entry.before.leaflet.id;
  const originalAuditId = entry.before.publicationAudit.id, auditId = withdrawalAuditId(run, entry.licenseNo);
  const restoreId = withdrawalAuditId(run, entry.licenseNo, true);
  return store.transaction(async (tx) => {
    const pointer = await tx.get("published", pointerId), leaflet = await tx.get("leaflets", leafletId);
    const originalAudit = await tx.get("audit", originalAuditId), audit = await tx.get("audit", auditId), restoreAudit = await tx.get("audit", restoreId);
    must(sameDocument(originalAudit, entry.before.publicationAudit), "withdrawal_original_audit_changed");
    const ownedAudit = !!audit && Number.isFinite(Date.parse(audit.at)) && sameDocument(audit, withdrawalAudit(entry, run, audit.at));
    const ownedWithdrawal = ownedAudit && sameDocument(leaflet, retired(entry, run, audit!.at)) && !pointer;
    if (mode === "withdraw") {
      if (ownedWithdrawal && !restoreAudit) return "already_withdrawn" as const;
      must(!audit && !restoreAudit && sameDocument(pointer, entry.before.pointer) && sameDocument(leaflet, entry.before.leaflet),
        "withdrawal_current_source_changed_since_snapshot");
      tx.set("leaflets", leafletId, retired(entry, run, timestamp));
      tx.delete("published", pointerId);
      tx.create("audit", auditId, withdrawalAudit(entry, run, timestamp));
      return "withdrawn" as const;
    }
    if (ownedAudit && restoreAudit && Number.isFinite(Date.parse(restoreAudit.at)) && sameDocument(restoreAudit, withdrawalAudit(entry, run, restoreAudit.at, true)) &&
      sameDocument(pointer, entry.before.pointer) && sameDocument(leaflet, entry.before.leaflet)) return "already_restored" as const;
    must(ownedWithdrawal && !restoreAudit, "withdrawal_restore_conflict_or_not_owned");
    tx.set("leaflets", leafletId, entry.before.leaflet);
    tx.create("published", pointerId, entry.before.pointer);
    tx.create("audit", restoreId, withdrawalAudit(entry, run, timestamp, true));
    return "restored_exact_snapshot" as const;
  });
}
