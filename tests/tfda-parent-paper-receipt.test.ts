import { describe, expect, it } from "vitest";
import { fetchedFromSuccessfulReceipt } from "../tools/prepare-tfda-parent-papers";
const requestedUrl = "https://mcp.fda.gov.tw/synthetic/start", finalUrl = "https://mcp.fda.gov.tw/synthetic/final";
const receipt = () => ({ requestedUrl, finalUrl, httpStatus: 200, fetchedAt: "2026-10-22T01:00:00Z", sourceBlobSha256: "a".repeat(64), bytes: 100,
  contentType: "text/html", redirects: [{ from: requestedUrl, to: finalUrl, httpStatus: 302 }] });
describe("actual successful redirect receipt conservation", () => {
  it("retains every recorded hop without inventing a final hop or mutating the raw receipt", () => {
    const record = receipt(), before = structuredClone(record);
    expect(fetchedFromSuccessfulReceipt(record, "html").redirectChain).toEqual([requestedUrl, finalUrl]); expect(record).toEqual(before);
  });
  it("accepts an explicit no-redirect HTTP200 receipt only when requested and final URLs agree", () => {
    expect(fetchedFromSuccessfulReceipt({ ...receipt(), finalUrl: requestedUrl, redirects: [] }, "html").redirectChain).toEqual([requestedUrl]);
    expect(() => fetchedFromSuccessfulReceipt({ ...receipt(), redirects: [] }, "html")).toThrow("parent_prepare_missing_actual_redirect_receipt");
  });
  it("does not synthesize a missing final redirect", () => {
    expect(() => fetchedFromSuccessfulReceipt({ ...receipt(), redirects: undefined }, "html")).toThrow("parent_prepare_missing_actual_redirect_receipt");
    expect(() => fetchedFromSuccessfulReceipt({ ...receipt(), redirects: [{ from: requestedUrl, to: "https://mcp.fda.gov.tw/intermediate", httpStatus: 302 }] }, "html"))
      .toThrow("parent_prepare_missing_actual_redirect_receipt");
  });
  it("rejects a noncontiguous, unsafe or unproven redirect chain", () => {
    for (const redirects of [
      [{ from: finalUrl, to: finalUrl, httpStatus: 302 }],
      [{ from: requestedUrl, to: finalUrl, httpStatus: 200 }],
      [{ from: requestedUrl, to: "http://mcp.fda.gov.tw/final", httpStatus: 302 }],
      [{ from: requestedUrl, to: finalUrl }],
      [requestedUrl, finalUrl],
    ]) expect(() => fetchedFromSuccessfulReceipt({ ...receipt(), redirects }, "html")).toThrow("parent_prepare_noncontiguous_or_unproven_redirect_receipt");
  });
  it("requires successful final HTTP200 and consistent duplicate receipt fields", () => {
    expect(() => fetchedFromSuccessfulReceipt({ ...receipt(), httpStatus: 503 }, "html")).toThrow("parent_prepare_successful_official_HTTP200_receipt_required");
    expect(() => fetchedFromSuccessfulReceipt({ ...receipt(), redirectChain: [] }, "html")).toThrow("parent_prepare_conflicting_redirect_receipts");
  });
});
