import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Chunk, Leaflet } from "../shared/schema";
import { equivalentSourceLayoutAudit } from "../tools/source-equivalence";

const source: Leaflet = {
  id: "synthetic-source",
  licenseNo: "SYNTHETIC-LICENSE",
  version: "synthetic-v1",
  sourceUrl: "https://example.org/synthetic-original.pdf",
  sha256: "a".repeat(64),
  storagePath: "leaflets/synthetic-original.pdf",
  status: "published",
  checkedBy: "original-reviewer",
  checkedAt: "2026-01-01T00:00:00.000Z",
  chunks: [],
};
const pageTexts = [
  "標題\n第一段，保留原字。\n第二段。 ",
  "第二頁\n末尾也須保留。\n",
];
const chunk = (
  id: string,
  page: number,
  start: number,
  text: string,
): Chunk => ({
  id,
  licenseNo: source.licenseNo,
  version: source.version,
  page,
  start,
  text,
});
const whole = (): Leaflet => ({
  ...source,
  checkedBy: "new-reviewer",
  checkedAt: "2026-02-01T00:00:00.000Z",
  chunks: pageTexts.map((text, index) =>
    chunk(`whole-${index + 1}`, index + 1, 0, text),
  ),
});
const split = (): Leaflet => ({
  ...source,
  chunks: pageTexts.flatMap((text, index) => [
    chunk(`split-${index + 1}-0`, index + 1, 0, text.slice(0, 5)),
    chunk(`split-${index + 1}-5`, index + 1, 5, text.slice(5)),
  ]),
});

describe("strict source layout equivalence for inactive snapshot merging", () => {
  it.each([
    ["split to whole", split, whole],
    ["whole to split", whole, split],
  ])(
    "accepts %s without changing either source or its review",
    (_name, a, b) => {
      const existing = a();
      const incoming = b();
      const original = structuredClone({ existing, incoming });
      const audit = equivalentSourceLayoutAudit(existing, incoming);
      expect(audit.decision).toBe(
        "retain_existing_source_record_and_chunk_ids",
      );
      expect(audit.existingReviewMetadataPreserved).toBe(true);
      expect(audit.existing.recordSha256).not.toBe(audit.incoming.recordSha256);
      expect(audit.existing.recordSha256).toBe(
        createHash("sha256").update(JSON.stringify(existing)).digest("hex"),
      );
      expect(audit.existing.identity).toEqual(audit.incoming.identity);
      expect(audit.existing.pageCount).toBe(2);
      expect(audit.existing.fullPages.map((page) => page.sha256)).toEqual(
        audit.incoming.fullPages.map((page) => page.sha256),
      );
      expect(audit.existing.fullPages.map((page) => page.characters)).toEqual(
        pageTexts.map((text) => text.length),
      );
      expect(audit.existing.chunkCount).toBe(existing.chunks.length);
      expect(audit.incoming.chunkCount).toBe(incoming.chunks.length);
      expect(audit.existing.fullPages[0].chunkIds).toEqual(
        existing.chunks
          .filter((part) => part.page === 1)
          .map((part) => part.id),
      );
      expect({ existing, incoming }).toEqual(original);
    },
  );

  it("uses explicit offsets when chunks arrive out of order", () => {
    const existing = split();
    existing.chunks.reverse();
    const originalOrder = existing.chunks.map((part) => part.id);
    expect(
      equivalentSourceLayoutAudit(existing, whole()).existing.chunkCount,
    ).toBe(4);
    expect(existing.chunks.map((part) => part.id)).toEqual(originalOrder);
  });

  it.each([
    ["id", "another-source"],
    ["licenseNo", "ANOTHER-LICENSE"],
    ["version", "synthetic-v2"],
    ["sha256", "b".repeat(64)],
    ["storagePath", "leaflets/different.pdf"],
    ["sourceUrl", "https://example.org/different.pdf"],
    ["status", "retired"],
    ["sourceMediaType", "application/pdf"],
  ] as const)("rejects different source identity %s", (field, value) => {
    const incoming = { ...whole(), [field]: value };
    expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
      `Source identity differs: ${field}`,
    );
  });

  it.each([
    ["a changed character", (text: string) => text.replace("第一段", "另一段")],
    ["a missing tail", (text: string) => text.slice(0, -1)],
    ["trimmed whitespace", (text: string) => text.trim()],
    ["normalized newlines", (text: string) => text.replaceAll("\n", "\r\n")],
  ])("rejects %s despite an identical PDF checksum", (_label, change) => {
    const incoming = whole();
    incoming.chunks[0].text = change(incoming.chunks[0].text);
    expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
      "Source text bytes differ",
    );
  });

  it.each([
    ["gap", 6],
    ["overlap", 4],
  ])("rejects a %s even when concatenated text is equal", (_label, start) => {
    const incoming = split();
    incoming.chunks[1].start = start;
    expect(() => equivalentSourceLayoutAudit(whole(), incoming)).toThrow(
      "gap or overlap",
    );
  });

  it("rejects a page that does not start at zero", () => {
    const incoming = whole();
    incoming.chunks[0].start = 1;
    expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
      "gap or overlap",
    );
  });

  it("rejects a missing final page", () => {
    const incoming = whole();
    incoming.chunks.pop();
    expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
      "Source page counts differ",
    );
  });

  it("rejects a missing middle page on both sides", () => {
    const existing = whole();
    const incoming = whole();
    existing.chunks[1].page = 3;
    incoming.chunks[1].page = 3;
    expect(() => equivalentSourceLayoutAudit(existing, incoming)).toThrow(
      "Missing existing source page",
    );
  });

  it("rejects moved page boundaries even when overall text is identical", () => {
    const incoming = whole();
    const tail = incoming.chunks[0].text.slice(-1);
    incoming.chunks[0].text = incoming.chunks[0].text.slice(0, -1);
    incoming.chunks[1].text = tail + incoming.chunks[1].text;
    expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
      "Source text bytes differ on page 1",
    );
  });

  it.each(["licenseNo", "version"] as const)(
    "rejects a chunk with a different %s",
    (field) => {
      const incoming = whole();
      incoming.chunks[0][field] = "different";
      expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
        "chunk source identity differs",
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid page %s",
    (page) => {
      const incoming = whole();
      incoming.chunks[0].page = page;
      expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
        "Invalid incoming chunk page",
      );
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid offset %s",
    (start) => {
      const incoming = whole();
      incoming.chunks[0].start = start;
      expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
        "Invalid incoming chunk start",
      );
    },
  );

  it("rejects duplicate chunk ids", () => {
    const incoming = split();
    incoming.chunks[1].id = incoming.chunks[0].id;
    expect(() => equivalentSourceLayoutAudit(whole(), incoming)).toThrow(
      "duplicate incoming chunk id",
    );
  });

  it("rejects a chunk format incompatible with the source media", () => {
    const incoming = whole();
    incoming.chunks[0].sourceFormat = "html";
    expect(() => equivalentSourceLayoutAudit(split(), incoming)).toThrow(
      "chunk format differs from its source media",
    );
  });

  it("accepts HTML layouts while retaining their explicit media identity", () => {
    const html = (value: Leaflet): Leaflet => ({
      ...value,
      sourceMediaType: "text/html",
      storagePath: "leaflets/synthetic-original.html",
      sourceUrl: "https://example.org/synthetic-original.html",
      chunks: value.chunks.map((part) => ({ ...part, sourceFormat: "html" })),
    });
    const audit = equivalentSourceLayoutAudit(html(split()), html(whole()));
    expect(audit.existing.identity.sourceMediaType).toBe("text/html");
    expect(audit.incoming.identity.effectiveMediaType).toBe("text/html");
  });
});
