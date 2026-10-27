import { describe, expect, it } from "vitest";
import { completePhysicalPageInventories } from "../tools/prepare-tfda-sources";

describe("TFDA physical-page conservation before preparation", () => {
  const canonical = { numPages: 2, pages: [{ page: 1, text: "official text" }, { page: 2, text: "" }] };
  const independent = { physicalPageCount: 2, allPhysicalPagesExtracted: true,
    pages: [{ page: 1, text: "official text" }, { page: 2, text: "" }] };

  it("keeps an extracted blank final page in the complete inventory", () => {
    expect(completePhysicalPageInventories(independent, canonical)).toBe(true);
  });
  it("rejects an independent engine that silently drops a blank page", () => {
    expect(completePhysicalPageInventories({ ...independent, pages: independent.pages.slice(0, 1) }, canonical)).toBe(false);
  });
  it("rejects differing physical-page counts despite matching text on the first page", () => {
    expect(completePhysicalPageInventories({ ...independent, physicalPageCount: 3 }, canonical)).toBe(false);
  });
  it("rejects duplicate, reordered, and skipped page positions on either side", () => {
    for (const pages of [[{ page: 1 }, { page: 1 }], [{ page: 2 }, { page: 1 }], [{ page: 1 }, { page: 3 }]]) {
      expect(completePhysicalPageInventories({ ...independent, pages }, canonical)).toBe(false);
      expect(completePhysicalPageInventories(independent, { ...canonical, pages })).toBe(false);
    }
  });
  it("rejects partial extraction and missing primary pages", () => {
    expect(completePhysicalPageInventories({ ...independent, allPhysicalPagesExtracted: false }, canonical)).toBe(false);
    expect(completePhysicalPageInventories(independent, { numPages: 2, pages: [] })).toBe(false);
    expect(completePhysicalPageInventories(null, null)).toBe(false);
  });
});
