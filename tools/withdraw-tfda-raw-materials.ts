/** Fixed three-source correction. Default inspect is read-only; never touches blobs or patient data. */
import { readFile, stat, mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  TFDA_PUBLICATION_PROJECT, TFDA_PUBLICATION_BUCKET, assertFreshTimestamp, assertPublicationWrite,
  canonicalDocument, publicationHash, publicationRequire as must, safePublicationFailure, technicalAuditId,
  type PublicationDoc,
} from "./tfda-publication-core.js";
import {
  RAW_MATERIAL_WITHDRAWAL_TARGETS, applyRawMaterialWithdrawal, officialWithdrawalCategory, validateWithdrawalEntry,
  type WithdrawalEntry, type WithdrawalRun, type WithdrawalStore,
} from "./tfda-raw-material-withdrawal-core.js";

async function bounded(path: string, limit: number) {
  must((await stat(path)).size <= limit, "withdrawal_input_too_large");
  const bytes = await readFile(path); must(bytes.length <= limit, "withdrawal_input_too_large"); return bytes;
}
const parse = (bytes: Buffer) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
const official = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
    (url.hostname === "fda.gov.tw" || url.hostname.endsWith(".fda.gov.tw")); } catch { return false; }
};
async function loadCatalog(path: string, evidencePath: string) {
  const bytes = await bounded(path, 150_000_000), evidenceBytes = await bounded(evidencePath, 200_000), evidence = parse(evidenceBytes);
  must(evidence.infoId === 36 && evidence.jsonSha256 === publicationHash(bytes) && evidence.jsonBytes === bytes.length &&
    evidence.httpStatus === 200 && official(evidence.requestedUrl) && official(evidence.finalUrl) && Array.isArray(evidence.redirects) &&
    evidence.redirects.every((hop: any) => official(hop.fromUrl) && official(hop.toUrl)), "withdrawal_official_catalog_evidence_invalid");
  assertFreshTimestamp(evidence.retrievedAt, Date.now(), "withdrawal_official_catalog_not_fresh");
  const rows = parse(bytes); must(Array.isArray(rows) && rows.length === evidence.rows, "withdrawal_catalog_row_count_mismatch");
  for (const licenseNo of Object.keys(RAW_MATERIAL_WITHDRAWAL_TARGETS)) officialWithdrawalCategory(rows, licenseNo);
  return { rows: rows as PublicationDoc[], sha256: publicationHash(bytes), evidenceSha256: publicationHash(evidenceBytes), path, evidencePath };
}
export interface WithdrawalSnapshot {
  schema: "tfda-raw-material-withdrawal/v1"; inspectedAt: string; runId: string;
  project: string; bucket: string; catalog: { sha256: string; evidenceSha256: string; path: string; evidencePath: string };
  entries: WithdrawalEntry[]; cloudWrites: 0; aiCalls: 0;
}
export function validateWithdrawalSnapshot(snapshot: WithdrawalSnapshot,
  catalog: { rows: PublicationDoc[]; sha256: string; evidenceSha256: string }, mode: "apply" | "restore", now = Date.now()) {
  must(snapshot?.schema === "tfda-raw-material-withdrawal/v1" && snapshot.project === TFDA_PUBLICATION_PROJECT && snapshot.bucket === TFDA_PUBLICATION_BUCKET &&
    typeof snapshot.runId === "string" && !!snapshot.runId && /^[a-f0-9]{64}$/.test(snapshot.catalog?.sha256 || "") &&
    /^[a-f0-9]{64}$/.test(snapshot.catalog?.evidenceSha256 || "") && Number.isFinite(Date.parse(snapshot.inspectedAt)) &&
    Array.isArray(snapshot.entries) && snapshot.entries.length === 3 && new Set(snapshot.entries.map((entry) => entry.licenseNo)).size === 3,
    "withdrawal_snapshot_target_or_catalog_mismatch");
  if (mode === "apply") {
    must(snapshot.catalog.sha256 === catalog.sha256 && snapshot.catalog.evidenceSha256 === catalog.evidenceSha256, "withdrawal_snapshot_target_or_catalog_mismatch");
    assertFreshTimestamp(snapshot.inspectedAt, now, "withdrawal_snapshot_not_fresh");
  }
  // Restoring an old exact snapshot still requires fresh, independently loaded official categories.
  // Its original catalog hash remains in the ownership marker; new evidence cannot rewrite that history.
  for (const entry of snapshot.entries) validateWithdrawalEntry(entry, catalog.rows);
}
export async function main(args = process.argv.slice(2)) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    must(["--mode", "--catalog", "--evidence", "--snapshot", "--snapshot-sha256", "--project", "--bucket"].includes(args[index]) &&
      !!args[index + 1] && !args[index + 1].startsWith("--") && !options[args[index]], "withdrawal_invalid_arguments");
    options[args[index]] = args[index + 1];
  }
  const mode = options["--mode"] || "inspect";
  must(["inspect", "apply", "restore"].includes(mode) && !!options["--catalog"] && !!options["--evidence"] && !!options["--snapshot"], "withdrawal_requires_catalog_evidence_snapshot");
  must(options["--project"] === TFDA_PUBLICATION_PROJECT && options["--bucket"] === TFDA_PUBLICATION_BUCKET, "withdrawal_explicit_fixed_target_required");
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT", "CLOUDSDK_CORE_PROJECT"])
    must(!process.env[key] || process.env[key] === TFDA_PUBLICATION_PROJECT, "withdrawal_incompatible_project_environment");
  must(!process.env.STORAGE_BUCKET || process.env.STORAGE_BUCKET === TFDA_PUBLICATION_BUCKET, "withdrawal_incompatible_bucket_environment");
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "STORAGE_EMULATOR_HOST"])
    must(!process.env[key], "withdrawal_emulator_forbidden");
  const snapshotPath = resolve(options["--snapshot"]), catalog = await loadCatalog(resolve(options["--catalog"]), resolve(options["--evidence"]));
  let snapshot: WithdrawalSnapshot | undefined, snapshotSha256 = "";
  if (mode !== "inspect") {
    must(/^[a-f0-9]{64}$/.test(options["--snapshot-sha256"] || ""), "withdrawal_apply_requires_exact_snapshot_hash");
    const bytes = await bounded(snapshotPath, 3_000_000); snapshotSha256 = publicationHash(bytes);
    must(snapshotSha256 === options["--snapshot-sha256"], "withdrawal_fixed_snapshot_hash_mismatch");
    snapshot = parse(bytes);
    validateWithdrawalSnapshot(snapshot!, catalog, mode === "apply" ? "apply" : "restore");
  }
  const { initializeApp, applicationDefault, getApps, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  must(getApps().length === 0, "withdrawal_preexisting_app_forbidden");
  const app = initializeApp({ credential: applicationDefault(), projectId: TFDA_PUBLICATION_PROJECT, storageBucket: TFDA_PUBLICATION_BUCKET });
  const db = getFirestore(app);
  const ref = (collection: string, id: string) => { assertPublicationWrite(collection, id); return db.collection(collection).doc(id); };
  try {
    if (mode === "inspect") {
      const licenses = Object.keys(RAW_MATERIAL_WITHDRAWAL_TARGETS), pointers = await db.getAll(...licenses.map((licenseNo) => ref("published", publicationHash(licenseNo))));
      const entries: WithdrawalEntry[] = [];
      for (let index = 0; index < licenses.length; index++) {
        const licenseNo = licenses[index], pointer = pointers[index].exists ? canonicalDocument(pointers[index].data()) as PublicationDoc : null;
        must(pointer && /^[a-f0-9]{64}$/.test(pointer.leafletId || ""), "withdrawal_expected_publication_missing");
        const source = await ref("leaflets", pointer.leafletId).get(), leaflet = source.exists ? canonicalDocument(source.data()) as PublicationDoc : null;
        must(leaflet && typeof leaflet.sourceImport?.runId === "string", "withdrawal_expected_imported_source_missing");
        const auditDoc = await ref("audit", technicalAuditId(leaflet.sourceImport.runId, leaflet.id)).get();
        must(auditDoc.exists, "withdrawal_publication_audit_missing");
        const entry = { licenseNo, officialCategory: officialWithdrawalCategory(catalog.rows, licenseNo),
          before: { pointer, leaflet, publicationAudit: canonicalDocument(auditDoc.data()) as PublicationDoc } };
        validateWithdrawalEntry(entry, catalog.rows); entries.push(entry);
      }
      const { rows: _rows, ...index } = catalog;
      const output: WithdrawalSnapshot = { schema: "tfda-raw-material-withdrawal/v1", inspectedAt: new Date().toISOString(), runId: randomUUID(),
        project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET, catalog: index, entries, cloudWrites: 0, aiCalls: 0 };
      await mkdir(dirname(snapshotPath), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(output, null, 2) + "\n");
      await writeFile(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ status: "withdrawal_readonly_snapshot_saved", snapshot: snapshotPath, snapshotSha256: publicationHash(bytes),
        catalogSha256: catalog.sha256, entries: entries.map(({ licenseNo, officialCategory, before }) => ({ licenseNo, officialCategory, leafletId: before.leaflet.id })), cloudWrites: 0, aiCalls: 0 }));
      return;
    }
    must(snapshot, "withdrawal_snapshot_required");
    const store: WithdrawalStore = { transaction: (operation) => db.runTransaction((transaction) => operation({
      get: async (collection, id) => { const doc = await transaction.get(ref(collection, id)); return doc.exists ? canonicalDocument(doc.data()) : null; },
      set: (collection, id, value) => { must(collection === "leaflets", "withdrawal_set_only_source"); transaction.set(ref(collection, id), value); },
      create: (collection, id, value) => { must(["published", "audit"].includes(collection), "withdrawal_create_only_pointer_or_audit"); transaction.create(ref(collection, id), value); },
      delete: (collection, id) => { must(collection === "published", "withdrawal_delete_only_pointer"); transaction.delete(ref(collection, id)); },
    })) };
    const run: WithdrawalRun = { runId: snapshot.runId, snapshotSha256, catalogSha256: snapshot.catalog.sha256 }, results = [];
    for (const entry of snapshot.entries) {
      const result = await applyRawMaterialWithdrawal(store, entry, catalog.rows, run, mode === "apply" ? "withdraw" : "restore");
      const record = { at: new Date().toISOString(), licenseNo: entry.licenseNo, result, mode, snapshotSha256, currentCatalogSha256: catalog.sha256 };
      await appendFile(snapshotPath + ".journal.ndjson", JSON.stringify(record) + "\n", { mode: 0o600, flush: true }); results.push(record);
    }
    console.log(JSON.stringify({ status: "fixed_three_source_correction_finished", mode, results, aiCalls: 0, blobsModified: 0 }));
  } finally { await deleteApp(app); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => { console.error(JSON.stringify(safePublicationFailure(error))); process.exitCode = 1; });
