import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Leaflet } from "../shared/schema.js";
import type { Doc, Store } from "../server/store.js";

export const sourceHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const sourceFields = [
  "id",
  "licenseNo",
  "version",
  "sourceUrl",
  "sha256",
  "storagePath",
  "chunks",
  "sourceMediaType",
] as const;
export interface SourceBefore {
  leaflet: Doc | null;
  pointer: Doc | null;
}
export interface SourceOperation {
  draft: Leaflet;
  before: SourceBefore;
}
export interface ImportRun {
  runId: string;
  manifestSha256: string;
  actor: string;
}
export function requireSource(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw Error(code);
}
export function sameSource(actual: Doc, expected: Leaflet) {
  return sourceFields.every((field) =>
    isDeepStrictEqual(actual[field], expected[field]),
  );
}
export function validateReviewedDraft(draft: Leaflet) {
  const url = new URL(draft.sourceUrl);
  requireSource(
    url.protocol === "https:" &&
      (url.hostname === "fda.gov.tw" || url.hostname.endsWith(".fda.gov.tw")),
    "official_https_source_required",
  );
  requireSource(
    /^[a-f0-9]{64}$/.test(draft.sha256) &&
      draft.id === sourceHash(draft.licenseNo + "|" + draft.sha256) &&
      draft.version === draft.sha256.slice(0, 16),
    "source_identity_mismatch",
  );
  const html = draft.sourceMediaType === "text/html";
  requireSource(
    draft.sourceMediaType === undefined ||
      draft.sourceMediaType === "text/html" ||
      draft.sourceMediaType === "application/pdf",
    "invalid_source_media_type",
  );
  requireSource(
    draft.storagePath === `leaflets/${draft.id}.${html ? "html" : "pdf"}`,
    "source_storage_path_mismatch",
  );
  requireSource(
    draft.status === "draft" &&
      draft.checkedBy === null &&
      draft.checkedAt === null,
    "local_review_identity_must_not_be_copied",
  );
  const allowed = [...sourceFields, "status", "checkedBy", "checkedAt"];
  requireSource(
    Object.keys(draft).every((key) =>
      allowed.includes(key as (typeof allowed)[number]),
    ),
    "non_source_draft_field_forbidden",
  );
  requireSource(
    draft.chunks.length > 0 &&
      Buffer.byteLength(JSON.stringify(draft.chunks)) <= 800000,
    "invalid_complete_source_chunks",
  );
  const pages = new Set<number>();
  for (const chunk of draft.chunks) {
    requireSource(
      Object.keys(chunk).every((key) =>
        [
          "id",
          "licenseNo",
          "version",
          "page",
          "start",
          "text",
          "sourceFormat",
        ].includes(key),
      ),
      "non_source_chunk_field_forbidden",
    );
    requireSource(
      Number.isSafeInteger(chunk.page) &&
        chunk.page > 0 &&
        !pages.has(chunk.page),
      "duplicate_or_invalid_source_page",
    );
    pages.add(chunk.page);
    requireSource(
      chunk.start === 0 &&
        chunk.text.trim().length > 0 &&
        chunk.text.length <= 22000 &&
        chunk.licenseNo === draft.licenseNo &&
        chunk.version === draft.version,
      "invalid_complete_source_page",
    );
    requireSource(
      chunk.id ===
        `${draft.id.slice(0, 16)}-${chunk.page}-0-whole-page-v1-${sourceHash(chunk.text).slice(0, 16)}`,
      "canonical_source_chunk_mismatch",
    );
    requireSource(
      !html || chunk.sourceFormat === "html",
      "html_source_format_required",
    );
    requireSource(
      html || chunk.sourceFormat === undefined || chunk.sourceFormat === "pdf",
      "pdf_source_format_required",
    );
  }
}
export function inspectPublication(draft: Leaflet, before: SourceBefore) {
  validateReviewedDraft(draft);
  if (before.leaflet) {
    requireSource(
      sameSource(before.leaflet, draft),
      "existing_source_content_conflict",
    );
    requireSource(
      ["draft", "published"].includes(before.leaflet.status),
      "existing_source_status_conflict",
    );
  }
  if (before.pointer) {
    requireSource(
      before.pointer.leafletId === draft.id &&
        before.pointer.version === draft.version,
      "different_source_already_published",
    );
    requireSource(
      before.leaflet?.status === "published" &&
        typeof before.leaflet.checkedBy === "string" &&
        before.leaflet.checkedBy.length > 0 &&
        typeof before.leaflet.checkedAt === "string" &&
        before.leaflet.checkedAt.length > 0,
      "inconsistent_published_source",
    );
    return "same_source_published" as const;
  }
  requireSource(
    before.leaflet?.status !== "published",
    "published_pointer_missing",
  );
  return before.leaflet ? ("existing_draft" as const) : ("new_source" as const);
}
function marker(run: ImportRun) {
  return { runId: run.runId, manifestSha256: run.manifestSha256 };
}
function owned(document: Doc | null, run: ImportRun) {
  return (
    !!document &&
    document.sourceImport?.runId === run.runId &&
    document.sourceImport?.manifestSha256 === run.manifestSha256 &&
    typeof document.sourceImport?.at === "string"
  );
}
function auditId(run: ImportRun, draft: Leaflet, action: string) {
  return sourceHash(`${run.runId}|${draft.id}|${action}`);
}
export async function applyReviewedSource(
  store: Pick<Store, "transaction">,
  operation: SourceOperation,
  run: ImportRun,
  timestamp = new Date().toISOString(),
) {
  validateReviewedDraft(operation.draft);
  requireSource(
    run.runId.length > 0 &&
      /^[a-f0-9]{64}$/.test(run.manifestSha256) &&
      run.actor.length > 0 &&
      run.actor !== "local-admin",
    "invalid_source_verification_actor_or_run",
  );
  return store.transaction(async (tx) => {
    const draft = operation.draft;
    const pointerId = sourceHash(draft.licenseNo);
    const current = {
      leaflet: await tx.get("leaflets", draft.id),
      pointer: await tx.get("published", pointerId),
    };
    const state = inspectPublication(draft, current);
    if (state === "same_source_published")
      return owned(current.pointer, run) && owned(current.leaflet, run)
        ? ("recovered_own_publication" as const)
        : ("same_source_no_op" as const);
    requireSource(
      isDeepStrictEqual(current, operation.before),
      "publication_changed_since_inspection",
    );
    const sourceImport = { ...marker(run), at: timestamp };
    // Same state transition as Domain.publish, with no prior source retirement:
    // the CAS above forbids replacing any different published source.
    tx.set("leaflets", draft.id, {
      ...current.leaflet,
      ...draft,
      status: "published",
      checkedBy: run.actor,
      checkedAt: timestamp,
      sourceImport,
    });
    tx.set("published", pointerId, {
      leafletId: draft.id,
      version: draft.version,
      sourceImport,
    });
    for (const action of [
      "leaflet.source_verification.literal_not_clinical",
      "leaflet.publish",
    ]) {
      const id = auditId(run, draft, action);
      tx.set("audit", id, {
        id,
        actor: run.actor,
        action,
        target: draft.id,
        at: timestamp,
        sourceImport,
        scope:
          "Literal official-source identity and complete text verification; not clinical or pharmacist review.",
      });
    }
    return "published" as const;
  });
}
export async function rollbackReviewedSource(
  store: Pick<Store, "transaction">,
  operation: SourceOperation,
  run: ImportRun,
  timestamp = new Date().toISOString(),
) {
  validateReviewedDraft(operation.draft);
  return store.transaction(async (tx) => {
    const draft = operation.draft;
    const pointerId = sourceHash(draft.licenseNo);
    const current = {
      leaflet: await tx.get("leaflets", draft.id),
      pointer: await tx.get("published", pointerId),
    };
    if (isDeepStrictEqual(current, operation.before))
      return "unchanged_no_op" as const;
    if (
      !current.pointer &&
      owned(current.leaflet, run) &&
      current.leaflet?.status === "retired"
    )
      return "already_rolled_back" as const;
    // A pre-existing pointer was only a no-op during apply; it is never owned.
    if (operation.before.pointer)
      return "preexisting_publication_preserved" as const;
    requireSource(
      owned(current.pointer, run) &&
        owned(current.leaflet, run) &&
        current.pointer?.leafletId === draft.id &&
        current.pointer.version === draft.version &&
        current.leaflet?.status === "published" &&
        sameSource(current.leaflet, draft),
      "rollback_conflict_not_owned_or_changed",
    );
    requireSource(
      current.leaflet.checkedBy === run.actor &&
        current.leaflet.checkedAt === current.leaflet.sourceImport.at &&
        isDeepStrictEqual(
          current.pointer.sourceImport,
          current.leaflet.sourceImport,
        ),
      "rollback_review_actor_or_time_changed",
    );
    tx.delete("published", pointerId);
    if (operation.before.leaflet)
      tx.set("leaflets", draft.id, operation.before.leaflet);
    else
      tx.set("leaflets", draft.id, { ...current.leaflet, status: "retired" });
    const action = "leaflet.source_import.rollback";
    const id = auditId(run, draft, action);
    tx.set("audit", id, {
      id,
      actor: run.actor,
      action,
      target: draft.id,
      at: timestamp,
      sourceImport: marker(run),
      scope:
        "Withdraw only this import's publication pointer; preserve source and blob.",
    });
    return "rolled_back" as const;
  });
}
