import type { GroundedResult, Leaflet } from "../shared/schema.js";
import { officialLeafletUrl } from "../shared/official-leaflet-url.js";
import { AppError } from "./config.js";

export const SOURCE_READER_VERSION = "source-reader-v3-structural-references";
// Parser capability changes age saved source holds only. Keep the previous
// identity for healthy generated caches; contentUpdateRequired rejects old
// holds selectively before reuse.
export const SOURCE_CACHE_VERSION = "source-reader-v2-literal-typography";
/** Only saved parser holds age with reader capability; normal model output stays current. */
export function sourceReviewOutdated(
  result: Pick<GroundedResult, "sourceReview"> | null | undefined,
) {
  return (
    result?.sourceReview?.reason === "safety_sections_pending" &&
    result.sourceReview.readerVersion !== SOURCE_READER_VERSION
  );
}

function sourceReferences(leaflets: Leaflet[]) {
  return [
    ...new Map(
      leaflets.map((leaflet) => [leaflet.licenseNo, leaflet]),
    ).values(),
  ].map((leaflet) => {
    const sourceUrl = officialLeafletUrl(leaflet.sourceUrl);
    return {
      licenseNo: leaflet.licenseNo,
      version: leaflet.version,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  });
}

/** A pending source review is a durable information state, with no generated
 * medical content. Only the caller's verified published leaflets supply links.
 * Other failures must retain the existing failed-job and retry behavior. */
export async function withSourceReviewResult(
  generate: () => Promise<GroundedResult>,
  leaflets: Leaflet[],
): Promise<GroundedResult> {
  try {
    const result = await generate();
    if (
      result.status === "insufficient_data" &&
      !!result.sourceReading &&
      ["model_source_capacity", "requested_topic_coverage"].includes(
        result.sourceReading.reason,
      ) &&
      leaflets.length &&
      leaflets.every((leaflet) => leaflet.status === "published")
    )
      return {
        ...result,
        sourceReading: {
          ...result.sourceReading,
          sources: sourceReferences(leaflets),
        },
      };
    return result;
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.code !== "source_requires_review" ||
      !leaflets.length ||
      leaflets.some((leaflet) => leaflet.status !== "published")
    )
      throw error;
    const sources = sourceReferences(leaflets);
    return {
      status: "insufficient_data",
      claims: [],
      chunks: [],
      quiz: [],
      followups: [],
      rejectedCount: 0,
      sourceVersions: Object.fromEntries(
        sources.map((source) => [source.licenseNo, source.version]),
      ),
      verification: "model_assisted",
      sourceReview: {
        reason: "safety_sections_pending",
        readerVersion: SOURCE_READER_VERSION,
        sources,
      },
    };
  }
}
