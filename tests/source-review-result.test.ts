import { describe, expect, it, vi } from "vitest";
import { AppError } from "../server/config";
import { withSourceReviewResult } from "../server/source-review-result";
import { officialLeafletUrl } from "../shared/official-leaflet-url";
import type { GroundedResult, Leaflet } from "../shared/schema";

const leaflet: Leaflet = {
  id: "synthetic-source-review",
  licenseNo: "SYNTHETIC-SOURCE-REVIEW",
  version: "0123456789abcdef",
  sourceUrl: "https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic?c=2",
  sha256: "synthetic-only",
  storagePath: "synthetic/source",
  status: "published",
  checkedBy: "synthetic-reviewer",
  checkedAt: "2026-10-23T00:00:00Z",
  chunks: [],
};
const hold = new AppError("source_requires_review", "合成來源暫待核對。", 422);
const throws = (error: unknown) => async (): Promise<GroundedResult> => {
  throw error;
};

describe("source review result boundary", () => {
  it("keeps exact published versions and official links without claims, passages, or quiz", async () => {
    const second = {
      ...leaflet,
      id: "two",
      licenseNo: "SYNTHETIC-TWO",
      version: "v2",
      sourceUrl: "https://info.fda.gov.tw/synthetic",
    };
    const result = await withSourceReviewResult(throws(hold), [
      leaflet,
      second,
      leaflet,
    ]);
    expect(result).toEqual({
      status: "insufficient_data",
      claims: [],
      chunks: [],
      quiz: [],
      followups: [],
      rejectedCount: 0,
      sourceVersions: {
        [leaflet.licenseNo]: leaflet.version,
        [second.licenseNo]: second.version,
      },
      verification: "model_assisted",
      sourceReview: {
        reason: "safety_sections_pending",
        sources: [leaflet, second].map(({ licenseNo, version, sourceUrl }) => ({
          licenseNo,
          version,
          sourceUrl,
        })),
      },
    });
  });

  it.each([
    "ai_timeout",
    "ai_auth_failed",
    "quota_exceeded",
    "invalid_ai_output",
    "stale_content",
  ])("preserves %s as a genuine failure", async (code) => {
    const error = new AppError(code, "合成失敗", 503);
    await expect(withSourceReviewResult(throws(error), [leaflet])).rejects.toBe(
      error,
    );
  });

  it("does not reinterpret arbitrary errors or objects claiming a hold code", async () => {
    for (const error of [
      Error("source_requires_review"),
      { code: "source_requires_review" },
    ])
      await expect(
        withSourceReviewResult(throws(error), [leaflet]),
      ).rejects.toBe(error);
  });

  it("passes normal model output through without inventing review metadata", async () => {
    const result: GroundedResult = {
      status: "not_found",
      claims: [],
      chunks: [],
      quiz: [],
      followups: [],
      rejectedCount: 0,
      sourceVersions: {},
      verification: "model_assisted",
    };
    const generate = vi.fn(async () => result);
    expect(await withSourceReviewResult(generate, [leaflet])).toBe(result);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("requires published source records and never invents a missing source link", async () => {
    for (const sources of [
      [],
      [{ ...leaflet, status: "draft" as const }],
      [{ ...leaflet, status: "retired" as const }],
    ])
      await expect(withSourceReviewResult(throws(hold), sources)).rejects.toBe(
        hold,
      );
    const result = await withSourceReviewResult(throws(hold), [
      { ...leaflet, sourceUrl: "javascript:alert(1)" },
    ]);
    expect(result.sourceReview?.sources).toEqual([
      { licenseNo: leaflet.licenseNo, version: leaflet.version },
    ]);
  });
});

describe("official source URL allowlist", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "http://mcp.fda.gov.tw/a",
    "//mcp.fda.gov.tw/a",
    "https://mcp.fda.gov.tw.evil.invalid/a",
    "https://evil.invalid/a",
    "https://unknown.fda.gov.tw/a",
    "https://user:pass@mcp.fda.gov.tw/a",
    "https://mcp.fda.gov.tw@evil.invalid/a",
    "https://mcp.fda.gov.tw:444/a",
    " https://mcp.fda.gov.tw/a",
    null,
  ])("rejects unsafe or unapproved URL %s", (url) => {
    expect(officialLeafletUrl(url)).toBeNull();
  });
  it.each([
    "mcp.fda.gov.tw",
    "info.fda.gov.tw",
    "www.fda.gov.tw",
    "fda.gov.tw",
  ])("permits official HTTPS host %s on the standard port", (host) => {
    expect(officialLeafletUrl(`https://${host}:443/a?c=2`)).toBe(
      `https://${host}/a?c=2`,
    );
  });
});

it.each(["model_source_capacity", "requested_topic_coverage"] as const)(
  "binds a %s reading state only to published metadata, replacing any claimed links",
  async (reason) => {
    const result: GroundedResult = {
      status: "insufficient_data",
      claims: [],
      chunks: [],
      quiz: [],
      followups: [],
      rejectedCount: 0,
      sourceVersions: { [leaflet.licenseNo]: leaflet.version },
      verification: "model_assisted",
      sourceReading: {
        reason,
        sections: [
          {
            sourceSection: "警語",
            citations: [{ chunkId: "synthetic", quote: "合成完整原文。" }],
          },
        ],
        sources: [
          {
            licenseNo: "invented",
            version: "untrusted",
            sourceUrl: "https://evil.invalid",
          },
        ],
      },
    };
    const reading = await withSourceReviewResult(async () => result, [leaflet]);
    expect(reading.sourceReading?.sections).toEqual(
      result.sourceReading?.sections,
    );
    expect(reading.sourceReading?.sources).toEqual([
      {
        licenseNo: leaflet.licenseNo,
        version: leaflet.version,
        sourceUrl: leaflet.sourceUrl,
      },
    ]);
    expect(reading.claims).toEqual([]);
    expect(reading.quiz).toEqual([]);
    const refusal = {
      ...result,
      status: "refused" as const,
      sourceReading: undefined,
    };
    expect(await withSourceReviewResult(async () => refusal, [leaflet])).toBe(
      refusal,
    );
  },
);
