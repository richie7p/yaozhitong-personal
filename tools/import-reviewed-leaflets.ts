/** Explicit source-only importer. Default is offline; never loads .env or AI modules. */
import {
  readFile,
  writeFile,
  open,
  unlink,
  appendFile,
  mkdir,
} from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { Leaflet } from "../shared/schema.js";
import type { Doc, Store, Tx } from "../server/store.js";
import {
  applyReviewedSource,
  inspectPublication,
  requireSource as must,
  rollbackReviewedSource,
  sourceHash,
  validateReviewedDraft,
  type ImportRun,
  type SourceBefore,
} from "./reviewed-leaflets-core.js";

async function main() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    must(
      [
        "--mode",
        "--manifest",
        "--verification",
        "--project",
        "--bucket",
        "--snapshot",
        "--actor",
      ].includes(args[i]) &&
        !!args[i + 1] &&
        !args[i + 1].startsWith("--") &&
        !options[args[i]],
      "invalid_or_duplicate_arguments",
    );
    options[args[i]] = args[i + 1];
  }
  const mode = options["--mode"] || "validate";
  must(
    ["validate", "inspect", "apply", "rollback"].includes(mode) &&
      !!options["--manifest"],
    "usage_requires_manifest_and_validate_inspect_apply_or_rollback_mode",
  );
  const readJson = async (file: string) =>
    JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  const manifestPath = resolve(options["--manifest"]);
  const pathFromManifest = (path: string) =>
    isAbsolute(path) ? path : resolve(dirname(manifestPath), path);
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sourceHash(manifestBytes);
  const manifest = JSON.parse(
    manifestBytes.toString("utf8").replace(/^\uFEFF/, ""),
  );
  must(
    manifest.schemaVersion === 1 &&
      Array.isArray(manifest.items) &&
      manifest.items.length > 0 &&
      manifest.items.length <= 50 &&
      manifest.sourceCount === manifest.items.length,
    "invalid_explicit_source_manifest",
  );
  must(
    new Set(manifest.items.map((item: any) => item.licenseNo)).size ===
      manifest.items.length,
    "duplicate_manifest_license",
  );
  const sources: { item: any; draft: Leaflet; bytes: Buffer }[] = [];
  for (const item of manifest.items) {
    must(
      ["pdf", "html"].includes(item.sourceFormat) &&
        item.sourceMediaType ===
          (item.sourceFormat === "html" ? "text/html" : "application/pdf"),
      "manifest_source_media_type_mismatch",
    );
    must(
      item.approvedScope === "official_leaflet_source_availability_only" &&
        item.clinicalReviewed === false &&
        item.safetySourceConditionsConserved === true,
      "explicit_literal_source_scope_required",
    );
    const draftBytes = await readFile(pathFromManifest(item.draftPath));
    must(
      sourceHash(draftBytes) === item.draftFileSha256,
      "draft_file_hash_mismatch",
    );
    const draft = JSON.parse(draftBytes.toString("utf8")) as Leaflet;
    validateReviewedDraft(draft);
    must(
      draft.licenseNo === item.licenseNo &&
        draft.id === item.leafletId &&
        draft.sha256 === item.sha256 &&
        draft.version === item.version &&
        draft.sourceUrl === item.sourceUrl &&
        draft.storagePath === item.storagePath,
      "manifest_source_identity_mismatch",
    );
    const bytes = await readFile(pathFromManifest(item.rawSourcePath));
    must(
      bytes.length <= 15000000 && sourceHash(bytes) === draft.sha256,
      "raw_source_hash_mismatch",
    );
    must(
      item.sourceFormat === "html"
        ? draft.sourceMediaType === "text/html" &&
            bytes.toString("utf8").includes("toggle-all")
        : bytes.subarray(0, 5).toString() === "%PDF-",
      "source_media_format_mismatch",
    );
    must(
      draft.chunks.length === 1 &&
        sourceHash(draft.chunks[0].text) === item.canonicalTextSha256,
      "complete_canonical_text_hash_mismatch",
    );
    const reviewBytes = await readFile(
      pathFromManifest(item.reviewEvidencePath),
    );
    must(
      sourceHash(reviewBytes) === item.reviewEvidenceSha256,
      "review_evidence_hash_mismatch",
    );
    const evidence = JSON.parse(reviewBytes.toString("utf8"));
    must(
      !!evidence.sourceReview &&
        typeof evidence.sourceReview.scope === "string" &&
        evidence.sourceReview.scope.length > 0,
      "source_review_scope_missing",
    );
    const passages = evidence.completeSourcePassagesOrSections;
    must(
      Array.isArray(passages) && passages.length > 0,
      "complete_source_review_passages_missing",
    );
    const compact = (value: string) =>
      value.normalize("NFKC").replace(/\s/gu, "");
    for (const passage of passages) {
      const quote =
        item.sourceFormat === "html"
          ? passage.heading + "\n" + passage.text
          : passage.quote;
      const chunk =
        item.sourceFormat === "html"
          ? draft.chunks[0]
          : draft.chunks.find((chunk) => chunk.id === passage.chunkId);
      must(
        chunk &&
          typeof quote === "string" &&
          compact(quote).length > 0 &&
          compact(chunk.text).includes(compact(quote)),
        "reviewed_complete_passage_not_in_source",
      );
      for (const condition of passage.requiredConditions || [])
        must(
          typeof condition === "string" &&
            compact(quote).includes(compact(condition)),
          "reviewed_source_condition_missing",
        );
    }
    if (item.sourceFormat === "html")
      must(
        evidence.sourceReview.canonical.completeMainDocument === true &&
          evidence.sourceReview.canonical.sections === passages.length &&
          evidence.sourceReview.canonicalSha256 === item.canonicalTextSha256,
        "complete_html_review_mismatch",
      );
    if (
      item.extraction ===
      "independently_reviewed_manual_full_page_transcription"
    )
      must(
        evidence.sourceReview.independentReview?.passed === true &&
          evidence.sourceReview.canonicalTextSha256 ===
            item.canonicalTextSha256,
        "manual_transcription_independent_review_missing",
      );
    sources.push({ item, draft, bytes });
  }

  let verificationSha256: string | undefined;
  if (mode === "inspect" || mode === "apply" || options["--verification"]) {
    must(
      !!options["--verification"],
      "fresh_official_verification_report_required",
    );
    const reportBytes = await readFile(resolve(options["--verification"]));
    const report = JSON.parse(reportBytes.toString("utf8"));
    const age = Date.now() - Date.parse(report.checkedAt);
    must(
      report.status === "passed" &&
        report.manifestSha256 === manifestSha256 &&
        report.currentOfficialIndexesStatus === "passed" &&
        report.networkScope === "official_TFDA_HTTPS_only" &&
        Number.isFinite(age) &&
        age >= -60000 &&
        age < 24 * 3600000,
      "official_verification_failed_or_older_than_24_hours",
    );
    for (const { item } of sources) {
      const row = report.items.find((row: any) => row.code === item.code);
      must(
        row?.status === "passed" &&
          row.currentOfficialLicenseVerified === true &&
          row.currentOfficialIndexVerified === true &&
          row.sourceUrl === item.sourceUrl &&
          row.sourceFormat === item.sourceFormat &&
          row.verifiedFrozenSourceStillCurrent === true &&
          (item.sourceFormat === "html"
            ? row.canonicalTextSha256 === item.canonicalTextSha256
            : row.retrievedSha256 === item.sha256),
        "official_current_source_verification_mismatch",
      );
      if (
        item.extraction ===
        "independently_reviewed_manual_full_page_transcription"
      )
        must(
          row.currentOfficialPaperLinkVerified === true,
          "reviewed_paper_source_current_mapping_missing",
        );
    }
    verificationSha256 = sourceHash(reportBytes);
  }
  if (mode === "validate") {
    console.log(
      JSON.stringify({
        status: "offline_source_manifest_validated",
        sourceCount: sources.length,
        manifestSha256,
        officialVerificationIncluded: !!verificationSha256,
        aiCalls: 0,
        cloudCalls: 0,
        cloudWrites: 0,
      }),
    );
    process.exit(0);
  }

  const project = options["--project"],
    bucketName = options["--bucket"],
    snapshotPath = options["--snapshot"] && resolve(options["--snapshot"]);
  must(
    !!project &&
      /^[a-z][a-z0-9-]{4,62}$/.test(project) &&
      !!bucketName &&
      /^[a-z0-9][a-z0-9._-]{1,220}$/.test(bucketName) &&
      !!snapshotPath,
    "explicit_project_bucket_and_snapshot_required",
  );
  for (const [key, expected] of Object.entries({
    APP_MODE: "firebase",
    GOOGLE_CLOUD_PROJECT: project,
    STORAGE_BUCKET: bucketName,
    GCLOUD_PROJECT: project,
    GCP_PROJECT: project,
    CLOUDSDK_CORE_PROJECT: project,
  }))
    must(
      !process.env[key] || process.env[key] === expected,
      "incompatible_environment_" + key,
    );
  for (const key of [
    "FIRESTORE_EMULATOR_HOST",
    "FIREBASE_AUTH_EMULATOR_HOST",
    "STORAGE_EMULATOR_HOST",
  ])
    must(!process.env[key], "emulator_configuration_forbidden");
  const actor = options["--actor"] || "codex-source-verification";
  must(
    actor.length <= 120 && /^[\w.@-]+$/.test(actor) && actor !== "local-admin",
    "invalid_literal_source_actor",
  );
  // No application server module is imported at runtime; experimental AI changes
  // cannot enter this source migration, and no AI secret is read or printed.
  const { initializeApp, applicationDefault, getApps, deleteApp } =
    await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  must(getApps().length === 0, "preexisting_firebase_app_forbidden");
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: project,
    storageBucket: bucketName,
  });
  must(
    app.options.projectId === project &&
      app.options.storageBucket === bucketName,
    "initialized_target_mismatch",
  );
  const firestore = getFirestore(app),
    bucket = getStorage(app).bucket(bucketName);
  const collectionRef = (name: string, id: string) => {
    must(
      ["leaflets", "published", "audit"].includes(name) && !id.includes("/"),
      "source_write_allowlist_violation",
    );
    return firestore.collection(name).doc(id);
  };
  const getSource = async (name: string, id: string) => {
    const document = await collectionRef(name, id).get();
    return document.exists ? document.data()! : null;
  };
  const store: Pick<Store, "transaction"> = {
    transaction: (operation) =>
      firestore.runTransaction(async (transaction) =>
        operation({
          get: async <T = Doc>(collection: string, id: string) => {
            const document = await transaction.get(
              collectionRef(collection, id),
            );
            return document.exists ? (document.data() as T) : null;
          },
          set: (collection, id, value) => {
            transaction.set(collectionRef(collection, id), value as Doc);
          },
          delete: (collection, id) => {
            must(
              collection === "published",
              "only_owned_publication_pointer_may_be_deleted",
            );
            transaction.delete(collectionRef(collection, id));
          },
        } as Tx),
      ),
  };
  async function blobState(source: (typeof sources)[number]) {
    const file = bucket.file(source.draft.storagePath);
    try {
      const [metadata] = await file.getMetadata();
      const [bytes] = await file.download({ validation: "crc32c" });
      must(
        sourceHash(bytes) === source.draft.sha256,
        "existing_cloud_blob_hash_mismatch",
      );
      return {
        exists: true,
        generation: String(metadata.generation),
        sha256: source.draft.sha256,
      };
    } catch (error) {
      if ((error as any)?.code !== 404) throw error;
      return { exists: false, generation: null, sha256: null };
    }
  }
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(snapshotPath), { recursive: true });
    lock = await open(snapshotPath + ".lock", "wx", 0o600);
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        mode,
        startedAt: new Date().toISOString(),
      }),
    );
    let snapshot: any;
    if (mode === "inspect") {
      // Only a read of the catalog pointer/blob, never copy or change settings.
      const setting = await firestore
        .collection("settings")
        .doc("catalog")
        .get();
      const catalogPointer = setting.data();
      must(
        catalogPointer &&
          /^catalog\/[a-f0-9]{16}\.json$/.test(catalogPointer.path),
        "cloud_catalog_pointer_missing_or_unexpected",
      );
      const [catalogBytes] = await bucket.file(catalogPointer.path).download();
      must(
        sourceHash(catalogBytes).slice(0, 16) === catalogPointer.version,
        "cloud_catalog_hash_mismatch",
      );
      const parsed = JSON.parse(catalogBytes.toString("utf8"));
      const catalog = Array.isArray(parsed) ? parsed : parsed.items;
      const norm = (value: string) =>
        value.normalize("NFKC").replace(/\s/gu, "");
      for (const { item, draft } of sources) {
        const drug = catalog.find(
          (drug: any) => drug.licenseNo === draft.licenseNo,
        );
        must(
          drug &&
            !drug.revoked &&
            norm(drug.nameZh) === norm(item.nameZh) &&
            norm(drug.nameEn) === norm(item.nameEn) &&
            norm(drug.form) === norm(item.form) &&
            norm(drug.strength) === norm(item.strength) &&
            Array.isArray(drug.ingredients) &&
            Array.isArray(item.ingredients) &&
            JSON.stringify(drug.ingredients.map(norm).sort()) ===
              JSON.stringify(item.ingredients.map(norm).sort()),
          "cloud_catalog_identity_mismatch_" + item.code,
        );
      }
      const entries = [];
      for (const source of sources) {
        const before: SourceBefore = {
          leaflet: await getSource("leaflets", source.draft.id),
          pointer: await getSource(
            "published",
            sourceHash(source.draft.licenseNo),
          ),
        };
        const action = inspectPublication(source.draft, before);
        const blob = await blobState(source);
        must(
          action !== "same_source_published" || blob.exists,
          "published_source_blob_missing",
        );
        entries.push({
          code: source.item.code,
          leafletId: source.draft.id,
          before,
          blob,
          action,
        });
      }
      snapshot = {
        schemaVersion: 1,
        inspectedAt: new Date().toISOString(),
        project,
        bucket: bucketName,
        runId: randomUUID(),
        actor,
        manifestSha256,
        verificationSha256,
        scope:
          "Source-only before snapshot; literal verification, not clinical review.",
        entries,
      };
      await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          status: "cloud_source_inspection_saved",
          project,
          bucket: bucketName,
          snapshot: snapshotPath,
          sourceCount: entries.length,
          actions: entries.map((entry) => ({
            code: entry.code,
            action: entry.action,
          })),
          cloudWrites: 0,
          aiCalls: 0,
        }),
      );
    } else {
      snapshot = await readJson(snapshotPath);
      must(
        snapshot.schemaVersion === 1 &&
          snapshot.project === project &&
          snapshot.bucket === bucketName &&
          snapshot.manifestSha256 === manifestSha256 &&
          snapshot.actor === actor &&
          typeof snapshot.runId === "string" &&
          snapshot.entries.length === sources.length,
        "snapshot_target_manifest_or_actor_mismatch",
      );
      if (mode === "apply")
        must(
          snapshot.verificationSha256 === verificationSha256,
          "official_report_changed_since_inspection",
        );
      const run: ImportRun = { runId: snapshot.runId, actor, manifestSha256 };
      const results = [];
      for (const source of sources) {
        const entry = snapshot.entries.find(
          (entry: any) =>
            entry.leafletId === source.draft.id &&
            entry.code === source.item.code,
        );
        must(
          !!entry && Object.hasOwn(entry, "before"),
          "snapshot_source_missing",
        );
        const operation = { draft: source.draft, before: entry.before };
        inspectPublication(source.draft, entry.before);
        let result: string;
        if (mode === "apply") {
          const currentBlob = await blobState(source);
          if (!currentBlob.exists) {
            must(
              !entry.before.pointer,
              "preexisting_published_blob_disappeared",
            );
            try {
              await bucket.file(source.draft.storagePath).save(source.bytes, {
                resumable: false,
                contentType: source.item.sourceMediaType,
                preconditionOpts: { ifGenerationMatch: 0 },
                metadata: {
                  metadata: {
                    sourceImportRunId: run.runId,
                    sourceSha256: source.draft.sha256,
                  },
                },
              });
            } catch (error) {
              if ((error as any)?.code !== 412) throw error;
              must(
                (await blobState(source)).exists,
                "racing_blob_create_failed",
              );
            }
          }
          result = await applyReviewedSource(store, operation, run);
          const after = {
            leaflet: await getSource("leaflets", source.draft.id),
            pointer: await getSource(
              "published",
              sourceHash(source.draft.licenseNo),
            ),
          };
          must(
            inspectPublication(source.draft, after) ===
              "same_source_published" && (await blobState(source)).exists,
            "source_publication_readback_failed",
          );
        } else {
          try {
            result = await rollbackReviewedSource(store, operation, run);
          } catch (error) {
            const code = (error as Error).message;
            must(code.startsWith("rollback_"), "rollback_failed");
            result = code;
            process.exitCode = 1;
          }
        }
        const record = {
          at: new Date().toISOString(),
          mode,
          code: source.item.code,
          result,
          runId: run.runId,
        };
        await appendFile(
          snapshotPath + ".journal.jsonl",
          JSON.stringify(record) + "\n",
          { mode: 0o600 },
        );
        results.push({ code: source.item.code, result });
      }
      console.log(
        JSON.stringify({
          status:
            mode === "apply"
              ? "source_import_completed"
              : process.exitCode
                ? "source_import_rollback_conflicts_preserved"
                : "source_import_rollback_completed",
          project,
          bucket: bucketName,
          runId: run.runId,
          results,
          sourceBlobsPreserved: true,
          existingSourceBlobsOverwritten: false,
          sourceBlobsDeleted: false,
          aiCalls: 0,
        }),
      );
    }
  } finally {
    if (lock) {
      await lock.close();
      await unlink(snapshotPath + ".lock");
    }
    await deleteApp(app);
  }
}
main().catch((error: unknown) => {
  const candidate =
    (error as any)?.message || (error as any)?.code || "source_import_failed";
  const errorCode = /^[A-Za-z0-9_/-]{1,120}$/.test(String(candidate))
    ? String(candidate)
    : "source_import_failed";
  console.error(JSON.stringify({ status: "failed", errorCode }));
  process.exitCode = 1;
});
