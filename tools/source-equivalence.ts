import { createHash } from "node:crypto";
import type { Leaflet } from "../shared/schema.js";

const identityFields = [
  "id",
  "licenseNo",
  "version",
  "sha256",
  "storagePath",
  "sourceUrl",
  "status",
  "sourceMediaType",
] as const;

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

interface PageLayout {
  page: number;
  text: string;
  characters: number;
  utf8Bytes: number;
  sha256: string;
  chunkCount: number;
  chunkIds: string[];
}

function sourceIdentity(source: Leaflet) {
  return {
    id: source.id,
    licenseNo: source.licenseNo,
    version: source.version,
    sha256: source.sha256,
    storagePath: source.storagePath,
    sourceUrl: source.sourceUrl,
    status: source.status,
    sourceMediaType: source.sourceMediaType ?? null,
    effectiveMediaType: source.sourceMediaType ?? "application/pdf",
  };
}

function pageLayouts(source: Leaflet, side: string): PageLayout[] {
  for (const field of identityFields.filter(
    (field) => field !== "sourceMediaType",
  ))
    if (typeof source[field] !== "string" || !source[field]?.trim())
      throw Error(`Invalid ${side} source identity: ${field}`);
  if (!/^[a-f0-9]{64}$/i.test(source.sha256))
    throw Error(`Invalid ${side} source checksum.`);
  if (!["draft", "published", "retired"].includes(source.status))
    throw Error(`Invalid ${side} source status.`);
  if (
    source.sourceMediaType !== undefined &&
    !["application/pdf", "text/html"].includes(source.sourceMediaType)
  )
    throw Error(`Invalid ${side} source media type.`);
  if (!Array.isArray(source.chunks) || !source.chunks.length)
    throw Error(`Missing ${side} source chunks.`);

  const expectedFormat =
    source.sourceMediaType === "text/html" ? "html" : "pdf";
  const byPage = new Map<number, Leaflet["chunks"]>();
  const chunkIds = new Set<string>();
  for (const chunk of source.chunks) {
    if (
      !chunk ||
      typeof chunk.id !== "string" ||
      !chunk.id.trim() ||
      chunkIds.has(chunk.id)
    )
      throw Error(`Invalid or duplicate ${side} chunk id.`);
    chunkIds.add(chunk.id);
    if (
      chunk.licenseNo !== source.licenseNo ||
      chunk.version !== source.version
    )
      throw Error(`The ${side} chunk source identity differs.`);
    if (!Number.isSafeInteger(chunk.page) || chunk.page < 1)
      throw Error(`Invalid ${side} chunk page.`);
    if (!Number.isSafeInteger(chunk.start) || chunk.start < 0)
      throw Error(`Invalid ${side} chunk start.`);
    if (typeof chunk.text !== "string" || !chunk.text.length)
      throw Error(`Missing ${side} chunk text.`);
    if (
      chunk.sourceFormat !== undefined &&
      chunk.sourceFormat !== expectedFormat
    )
      throw Error(`The ${side} chunk format differs from its source media.`);
    const page = byPage.get(chunk.page) ?? [];
    page.push(chunk);
    byPage.set(chunk.page, page);
  }

  return [...byPage]
    .sort(([a], [b]) => a - b)
    .map(([page, chunks], index) => {
      if (page !== index + 1)
        throw Error(`Missing ${side} source page before page ${page}.`);
      const ordered = [...chunks].sort((a, b) => a.start - b.start);
      let offset = 0;
      for (const chunk of ordered) {
        if (chunk.start !== offset)
          throw Error(`The ${side} page ${page} has a gap or overlap.`);
        offset += chunk.text.length;
      }
      const text = ordered.map((chunk) => chunk.text).join("");
      return {
        page,
        text,
        characters: text.length,
        utf8Bytes: Buffer.byteLength(text, "utf8"),
        sha256: sha256(text),
        chunkCount: ordered.length,
        chunkIds: ordered.map((chunk) => chunk.id),
      };
    });
}

/** Proves layout equivalence only; it never substitutes a source or its review. */
export function equivalentSourceLayoutAudit(
  existing: Leaflet,
  incoming: Leaflet,
) {
  for (const field of identityFields)
    if (existing[field] !== incoming[field])
      throw Error(`Source identity differs: ${field}`);
  const existingPages = pageLayouts(existing, "existing");
  const incomingPages = pageLayouts(incoming, "incoming");
  if (existingPages.length !== incomingPages.length)
    throw Error("Source page counts differ.");
  for (let index = 0; index < existingPages.length; index++) {
    const previous = existingPages[index];
    const next = incomingPages[index];
    if (
      previous.page !== next.page ||
      previous.text !== next.text ||
      !Buffer.from(previous.text, "utf8").equals(Buffer.from(next.text, "utf8"))
    )
      throw Error(`Source text bytes differ on page ${previous.page}.`);
  }
  const evidence = (source: Leaflet, pages: PageLayout[]) => ({
    recordSha256: sha256(JSON.stringify(source)),
    identity: sourceIdentity(source),
    pageCount: pages.length,
    chunkCount: source.chunks.length,
    fullPages: pages.map(({ text: _text, ...page }) => page),
  });
  return {
    sourceId: existing.id,
    decision: "retain_existing_source_record_and_chunk_ids" as const,
    basis:
      "Identical source identity and exact UTF-8 page text; each layout starts at zero and is contiguous, without gaps or overlaps.",
    existing: evidence(existing, existingPages),
    incoming: evidence(incoming, incomingPages),
    existingReviewMetadataPreserved: true,
    scope:
      "Layout equivalence only; this does not replace source review or establish completeness against the original document.",
  };
}
