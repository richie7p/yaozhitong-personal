import { describe, expect, it } from "vitest";
import {
  TFDA_PUBLICATION_ACTOR, TFDA_PUBLICATION_BUCKET, TFDA_PUBLICATION_PROJECT, TFDA_PROTECTED_LICENSES, assertPublicationWrite, publicationHash, technicalAuditId,
  type PublicationDoc,
} from "../tools/tfda-publication-core";
import {
  RAW_MATERIAL_WITHDRAWAL_ACTOR, RAW_MATERIAL_WITHDRAWAL_TARGETS, applyRawMaterialWithdrawal,
  officialWithdrawalCategory, validateWithdrawalEntry, withdrawalAuditId,
  type WithdrawalEntry, type WithdrawalRun, type WithdrawalStore,
} from "../tools/tfda-raw-material-withdrawal-core";
import { validateWithdrawalSnapshot, type WithdrawalSnapshot } from "../tools/withdraw-tfda-raw-materials";

// Synthetic documents and text only. These tests never contact Firestore, Storage or a model.
const when = "2026-10-22T03:00:00.000Z", later = "2026-10-22T03:05:00.000Z";
const licenseNo = "衛署藥製字第055117號";
const rows = [{ "許可證字號": licenseNo, "藥品類別": "原料藥", "中文品名": "合成原料測試品" }];
const run: WithdrawalRun = { runId: "synthetic-correction", snapshotSha256: "c".repeat(64), catalogSha256: "d".repeat(64) };
function fixture(): WithdrawalEntry {
  const sha256 = "a".repeat(64), id = publicationHash(licenseNo + "|" + sha256);
  const sourceImport = { runId: "synthetic-import", batchId: "synthetic-batch", manifestSha256: "1".repeat(64), snapshotSha256: "2".repeat(64), at: when };
  const leaflet = { id, licenseNo, status: "published", sha256, version: sha256.slice(0, 16), checkedBy: TFDA_PUBLICATION_ACTOR,
    checkedAt: when, sourceImport, sourceUrl: "https://mcp.fda.gov.tw/synthetic/raw.pdf", rawStoragePath: "synthetic/raw.pdf",
    chunks: [{ page: 1, text: "Synthetic complete raw material source page. Never clinical instructions." }, { page: 2, text: "Synthetic complete second page with conditions and exceptions." }],
    sourceVerification: { actor: TFDA_PUBLICATION_ACTOR, humanReviewed: false, clinicalReviewed: false, rawSourceSha256: sha256 } };
  return { licenseNo, officialCategory: "原料藥", before: { leaflet, pointer: { leafletId: id, version: leaflet.version, sourceImport },
    publicationAudit: { id: technicalAuditId(sourceImport.runId, id), actor: TFDA_PUBLICATION_ACTOR, action: "leaflet.technical_source_publish",
      target: id, at: when, sourceImport, clinicalReviewed: false } } };
}
class MemoryStore implements WithdrawalStore {
  data: Record<string, Record<string, PublicationDoc>>;
  writes: [string, string, string][] = [];
  constructor(entry = fixture()) {
    this.data = { published: { [publicationHash(entry.licenseNo)]: structuredClone(entry.before.pointer) },
      leaflets: { [entry.before.leaflet.id]: structuredClone(entry.before.leaflet) }, audit: { [entry.before.publicationAudit.id]: structuredClone(entry.before.publicationAudit) },
      patients: { syntheticPatient: { untouched: true } }, usage: { syntheticUsage: { untouched: true } } };
    for (const protectedLicense of TFDA_PROTECTED_LICENSES) this.data.published[publicationHash(protectedLicense)] = { syntheticProtected: protectedLicense };
  }
  async transaction<T>(operation: Parameters<WithdrawalStore["transaction"]>[0]): Promise<T> {
    const state = structuredClone(this.data), writes: [string, string, string][] = [];
    const result = await operation({
      get: async (collection, id) => { assertPublicationWrite(collection, id); return structuredClone(state[collection]?.[id] ?? null); },
      set: (collection, id, value) => { assertPublicationWrite(collection, id); (state[collection] ||= {})[id] = structuredClone(value); writes.push(["set", collection, id]); },
      create: (collection, id, value) => { assertPublicationWrite(collection, id); if (state[collection]?.[id]) throw Error("create_precondition_failed");
        (state[collection] ||= {})[id] = structuredClone(value); writes.push(["create", collection, id]); },
      delete: (collection, id) => { assertPublicationWrite(collection, id); delete state[collection]?.[id]; writes.push(["delete", collection, id]); },
    });
    this.data = state; this.writes.push(...writes); return result as T;
  }
}
describe("fixed-three official raw material correction", () => {
  it("retires only the imported source, preserves full text and raw metadata, and is crash-resumable", async () => {
    const entry = fixture(), store = new MemoryStore(entry), before = structuredClone(store.data);
    expect(await applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", when)).toBe("withdrawn");
    const retired = store.data.leaflets[entry.before.leaflet.id];
    expect(retired).toEqual({ ...entry.before.leaflet, status: "retired", sourceWithdrawal: { ...run, at: when,
      actor: RAW_MATERIAL_WITHDRAWAL_ACTOR, reason: "official_raw_material_not_patient_leaflet", officialCategory: "原料藥" } });
    expect(store.data.published[publicationHash(licenseNo)]).toBeUndefined();
    expect(store.data.audit[withdrawalAuditId(run, licenseNo)]).toMatchObject({ sourceImport: entry.before.leaflet.sourceImport, reason: "official_raw_material_not_patient_leaflet" });
    expect(store.writes.map(([action, collection]) => [action, collection])).toEqual([["set", "leaflets"], ["delete", "published"], ["create", "audit"]]);
    expect(store.data.patients).toEqual(before.patients); expect(store.data.usage).toEqual(before.usage);
    for (const protectedLicense of TFDA_PROTECTED_LICENSES) expect(store.data.published[publicationHash(protectedLicense)]).toEqual(before.published[publicationHash(protectedLicense)]);
    const withdrawn = structuredClone(store.data);
    expect(await applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", later)).toBe("already_withdrawn");
    expect(store.data).toEqual(withdrawn); expect(store.writes).toHaveLength(3);
  });
  it("restores the exact original snapshot only while the owned withdrawal remains unchanged", async () => {
    const entry = fixture(), store = new MemoryStore(entry);
    await applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", when);
    expect(await applyRawMaterialWithdrawal(store, entry, rows, run, "restore", later)).toBe("restored_exact_snapshot");
    expect(store.data.leaflets[entry.before.leaflet.id]).toEqual(entry.before.leaflet);
    expect(store.data.published[publicationHash(licenseNo)]).toEqual(entry.before.pointer);
    const restored = structuredClone(store.data), count = store.writes.length;
    expect(await applyRawMaterialWithdrawal(store, entry, rows, run, "restore", when)).toBe("already_restored");
    expect(store.data).toEqual(restored); expect(store.writes).toHaveLength(count);
    await expect(applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", later)).rejects.toThrow("withdrawal_current_source_changed_since_snapshot");
  });
  it.each(["pointer", "leaflet", "audit"])("refuses a changed current %s without any writes", async (field) => {
    const entry = fixture(), store = new MemoryStore(entry);
    if (field === "pointer") store.data.published[publicationHash(licenseNo)].version = "replacement";
    if (field === "leaflet") store.data.leaflets[entry.before.leaflet.id].chunks[0].text += " changed";
    if (field === "audit") store.data.audit[entry.before.publicationAudit.id].actor = "other-actor";
    const changed = structuredClone(store.data);
    await expect(applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", when)).rejects.toThrow(/withdrawal_(current_source_changed_since_snapshot|original_audit_changed)/);
    expect(store.data).toEqual(changed); expect(store.writes).toHaveLength(0);
  });
  it.each(["replacement_pointer", "retired_text_changed", "withdrawal_audit_changed"])("refuses restore after %s", async (attack) => {
    const entry = fixture(), store = new MemoryStore(entry);
    await applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", when);
    if (attack === "replacement_pointer") store.data.published[publicationHash(licenseNo)] = { leafletId: "b".repeat(64), version: "replacement" };
    if (attack === "retired_text_changed") store.data.leaflets[entry.before.leaflet.id].chunks[0].text += " changed";
    if (attack === "withdrawal_audit_changed") store.data.audit[withdrawalAuditId(run, licenseNo)].reason = "different_reason";
    const changed = structuredClone(store.data), count = store.writes.length;
    await expect(applyRawMaterialWithdrawal(store, entry, rows, run, "restore", later)).rejects.toThrow("withdrawal_restore_conflict_or_not_owned");
    expect(store.data).toEqual(changed); expect(store.writes).toHaveLength(count);
  });
  it("does not call a restored source an owned no-op after the withdrawal audit was deleted", async () => {
    const entry = fixture(), store = new MemoryStore(entry);
    await applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", when);
    await applyRawMaterialWithdrawal(store, entry, rows, run, "restore", later);
    delete store.data.audit[withdrawalAuditId(run, licenseNo)];
    const changed = structuredClone(store.data), count = store.writes.length;
    await expect(applyRawMaterialWithdrawal(store, entry, rows, run, "restore", later)).rejects.toThrow("withdrawal_restore_conflict_or_not_owned");
    expect(store.data).toEqual(changed); expect(store.writes).toHaveLength(count);
  });
  it("can restore a pinned snapshot after 24 hours using fresh official category evidence, while apply remains freshness bound", () => {
    const entries = Object.entries(RAW_MATERIAL_WITHDRAWAL_TARGETS).map(([licenseNo, officialCategory]) => {
      const entry = fixture(), sha256 = entry.before.leaflet.sha256, id = publicationHash(licenseNo + "|" + sha256);
      entry.licenseNo = licenseNo; entry.officialCategory = officialCategory;
      entry.before.leaflet.licenseNo = licenseNo; entry.before.leaflet.id = id; entry.before.pointer.leafletId = id;
      entry.before.publicationAudit.id = technicalAuditId(entry.before.leaflet.sourceImport.runId, id); entry.before.publicationAudit.target = id;
      return entry;
    });
    const snapshot: WithdrawalSnapshot = { schema: "tfda-raw-material-withdrawal/v1", inspectedAt: when, runId: run.runId,
      project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET,
      catalog: { sha256: run.catalogSha256, evidenceSha256: "e".repeat(64), path: "synthetic-original.json", evidencePath: "synthetic-evidence.json" },
      entries, cloudWrites: 0, aiCalls: 0 };
    const freshCatalog = { rows: entries.map(({ licenseNo, officialCategory }) => ({ "許可證字號": licenseNo, "藥品類別": officialCategory })),
      sha256: "f".repeat(64), evidenceSha256: "9".repeat(64) };
    const nextDay = Date.parse(when) + 48 * 3600_000;
    expect(() => validateWithdrawalSnapshot(snapshot, freshCatalog, "restore", nextDay)).not.toThrow();
    expect(() => validateWithdrawalSnapshot(snapshot, freshCatalog, "apply", nextDay)).toThrow("withdrawal_snapshot_target_or_catalog_mismatch");
    expect(() => validateWithdrawalSnapshot(snapshot, { ...freshCatalog, sha256: snapshot.catalog.sha256, evidenceSha256: snapshot.catalog.evidenceSha256 }, "apply", nextDay)).toThrow("withdrawal_snapshot_not_fresh");
    freshCatalog.rows[0]["藥品類別"] = "合成病人用藥";
    expect(() => validateWithdrawalSnapshot(snapshot, freshCatalog, "restore", nextDay)).toThrow("withdrawal_current_official_category_mismatch");
  });
  it.each(["manual_actor", "human_reviewed", "clinical_reviewed", "pointer_marker", "publication_audit"])("rejects snapshot ownership spoof: %s", async (attack) => {
    const entry = fixture();
    if (attack === "manual_actor") entry.before.leaflet.checkedBy = "manual-pharmacist";
    if (attack === "human_reviewed") entry.before.leaflet.sourceVerification.humanReviewed = true;
    if (attack === "clinical_reviewed") entry.before.leaflet.sourceVerification.clinicalReviewed = true;
    if (attack === "pointer_marker") entry.before.pointer.sourceImport = { ...entry.before.pointer.sourceImport, runId: "other-run" };
    if (attack === "publication_audit") entry.before.publicationAudit.at = later;
    const store = new MemoryStore(entry);
    await expect(applyRawMaterialWithdrawal(store, entry, rows, run, "withdraw", when)).rejects.toThrow(/withdrawal_(not_owned|nonautomated|original_publication_audit)/);
    expect(store.writes).toHaveLength(0);
  });
  it("uses exact official full licenses and categories rather than candidate declarations or numeric suffixes", () => {
    expect(Object.keys(RAW_MATERIAL_WITHDRAWAL_TARGETS)).toHaveLength(3);
    expect(officialWithdrawalCategory([...rows, ...rows], licenseNo)).toBe("原料藥");
    expect(() => officialWithdrawalCategory([{ ...rows[0], "藥品類別": "須由醫師處方使用" }], licenseNo)).toThrow("withdrawal_current_official_category_mismatch");
    expect(() => officialWithdrawalCategory([...rows, { ...rows[0], "藥品類別": "須由醫師處方使用" }], licenseNo)).toThrow("withdrawal_current_official_category_mismatch");
    expect(() => officialWithdrawalCategory([{ ...rows[0], "許可證字號": "衛署藥輸字第055117號" }], licenseNo)).toThrow("withdrawal_current_official_category_mismatch");
    for (const protectedLicense of TFDA_PROTECTED_LICENSES) expect(() => officialWithdrawalCategory(rows, protectedLicense)).toThrow("withdrawal_target_not_one_of_fixed_three");
    const entry = fixture(); entry.officialCategory = "須由醫師處方使用";
    expect(() => validateWithdrawalEntry(entry, rows)).toThrow("withdrawal_snapshot_category_mismatch");
  });
});
