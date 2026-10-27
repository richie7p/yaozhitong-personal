import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { HTML_OUTLINE_SERIALIZATION, validateHtmlNumberedOutlineReport, verifyCandidateFromRaw } from "../tools/tfda-candidate-verification.js";
import { publicationHash } from "../tools/tfda-publication-core.js";
import { evaluateTfdaSource, type TfdaSourceInput } from "../tools/tfda-source-core.js";

const runFile = promisify(execFile), python = process.env.TFDA_TEST_PYTHON || "python";
const license = "衛署藥製字第012345號", nameZh = "合成綱目測試錠", nameEn = "SYNTHETIC OUTLINE TEST TABLETS";
const url = "https://mcp.fda.gov.tw/exportpdf/" + license;
const body = "本段是合成測試資料，並非真實藥品資訊。每個條件、文字、列及欄均須完整保留，不得自行加入結論或改動來源。".repeat(4);
const raw = Buffer.from(`<!doctype html><html><body>
<div class="page_name"><label>中文品名</label><span>${nameZh}</span></div>
<div class="page_name"><label>英文品名</label><span>${nameEn}</span></div>
<div class="page_name"><label>許可證號</label><span>${license}</span></div>
<div class="page_name"><label>藥品類別</label><span>合成處方藥</span></div>
<div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">5 警語及注意事項</span></div>
<div class="toggle-inner"><table><tr><td>5.1</td><td>警語/注意事項</td></tr><tr><td></td><td><table>
<tr><td>5.1.1</td><td><p>${body}</p></td></tr><tr><td>5.1.2</td><td>這是第二個合成項目。</td></tr>
</table></td></tr></table></div></div></div></body></html>`);
let folder: string, rawPath: string, report: any, input: TfdaSourceInput;
async function inspect(bytes: Buffer, outline = true) {
  const path = join(folder, randomUUID() + ".html"); await writeFile(path, bytes);
  const result = await runFile(python, ["-X", "utf8", resolve("tools/fetch-tfda-sources.py"),
    outline ? "--inspect-html-outline-internal" : "--inspect-html-internal", path, url],
  { windowsHide: true, encoding: "utf8", maxBuffer: 2_000_000 });
  return { path, report: JSON.parse(result.stdout.trim()) };
}
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "tfda-outline-test-"));
  const inspected = await inspect(raw); rawPath = inspected.path; report = inspected.report;
  const text = [nameZh, nameEn, license, "合成處方藥"].join("\n") + "\n\n" + report.normalizedSectionText;
  const now = new Date().toISOString();
  input = { licenseNo: license, officialCategory: "合成處方藥", checkedAt: now, catalogCheckedAt: now, indexCheckedAt: now,
    catalogRows: [{ licenseNo: license, nameZh, nameEn, form: "合成錠劑", manufacturer: "合成製造商", effectiveUntil: "2035/12/31", revoked: false }],
    indexRows: [{ licenseNo: license, nameZh, nameEn, urls: [url] }],
    fetched: { requestedUrl: url, finalUrl: url, redirectChain: [url], retrievedAt: now, sha256: publicationHash(raw), bytes: raw.length, mediaType: "text/html", contentSignature: "html" },
    format: "html", numPages: 1, pages: [{ page: 1, text, embeddedImages: 0, hasLargeUnverifiedImage: false }],
    htmlEvidence: { completeMainDocument: true, domConservationPassed: true, canonicalTextSha256: publicationHash(text), sectionCount: 1,
      hasUnverifiedNonTextContent: false, tableSerializationVersion: HTML_OUTLINE_SERIALIZATION,
      numberedOutlineEvidenceSha256: publicationHash(JSON.stringify(report.numberedOutlineEvidence)) } };
});
afterAll(async () => {
  if (folder) { expect(resolve(folder).startsWith(resolve(tmpdir()) + sep)).toBe(true); await rm(folder, { recursive: true, force: true }); }
});

describe("explicit numbered-outline raw capability", () => {
  it("requires an exact raw reparse and carries the entire numbered hierarchy", async () => {
    expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);
    expect(validateHtmlNumberedOutlineReport(report)).toEqual(report.numberedOutlineEvidence);
    const proof = await verifyCandidateFromRaw(rawPath, raw, input, { python });
    expect(proof.method).toBe("html_raw_numbered_outline_reparse_v1");
    expect(proof.htmlNumberedOutlineEvidence).toEqual(report.numberedOutlineEvidence);
    expect(proof.derivedHtmlEvidenceSha256).toBe(publicationHash(JSON.stringify(input.htmlEvidence)));
    expect(input.pages[0].text).toContain("\t5.1.1\t");
  });

  it.each(["tableCount", "newlySupportedComplexTableCount"])("rejects a fabricated %s instead of treating a simple flag as authority", (field) => {
    const changed = structuredClone(report); changed.numberedOutlineEvidence[field] += 1;
    expect(() => validateHtmlNumberedOutlineReport(changed)).toThrow();
  });

  it("rejects a changed cell or erased child hierarchy", () => {
    const changed = structuredClone(report);
    changed.numberedOutlineEvidence.roots[0].table.rows[1].rightPieces[0].table.rows[0].rightPieces[0].text += "額外聲稱。";
    expect(() => validateHtmlNumberedOutlineReport(changed)).toThrow("raw_html_numbered_outline_cell_text_not_conserved");
    const erased = structuredClone(report); erased.numberedOutlineEvidence.roots[0].table.rows[1].rightPieces = [{ kind: "text", text: "省略原始條件。" }];
    expect(() => validateHtmlNumberedOutlineReport(erased)).toThrow();
  });

  it("rejects child tables moved into a different numbered scope", () => {
    const changed = structuredClone(report); changed.numberedOutlineEvidence.roots[0].table.rows[1].rightPieces[0].table.scope = "6.1";
    expect(() => validateHtmlNumberedOutlineReport(changed)).toThrow("raw_html_numbered_outline_table_invalid");
  });

  it("rejects unknown proof fields and a fabricated negative section index", () => {
    const changed = structuredClone(report); changed.numberedOutlineEvidence.uncheckedClinicalMeaning = "invented";
    expect(() => validateHtmlNumberedOutlineReport(changed)).toThrow("raw_html_numbered_outline_evidence_shape_invalid");
    const moved = structuredClone(report); moved.numberedOutlineEvidence.roots[0].sectionIndex = -1;
    expect(() => validateHtmlNumberedOutlineReport(moved)).toThrow("raw_html_numbered_outline_root_invalid");
  });

  it.each([
    ["unverified", "html", "invalid_html_mode"],
    ["numbered-outline-v1", "pdf", "numbered_outline_requires_html_source_format"],
  ])("rejects invalid HTML mode %s with source-format %s before any source access", async (mode, format, code) => {
    await expect(runFile(process.execPath, ["--import", "tsx", resolve("tools/prepare-tfda-sources.ts"),
      "--inventory", folder, "--corpus", folder, "--output", join(folder, "must-not-create"), "--source-format", format, "--html-mode", mode],
    { windowsHide: true, encoding: "utf8" })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(code) });
  });

  it("rejects row, table-index or original-DOM hash changes", () => {
    for (const change of [
      (x: any) => x.numberedOutlineEvidence.roots[0].table.rows.reverse(),
      (x: any) => x.numberedOutlineEvidence.tableIndices.reverse(),
      (x: any) => x.numberedOutlineEvidence.originalNormalizedDomSha256 = "a".repeat(64),
    ]) {
      const changed = structuredClone(report); change(changed); expect(() => validateHtmlNumberedOutlineReport(changed)).toThrow();
    }
  });

  it("does not accept an unknown capability marker even with an unavailable parser", async () => {
    const changed = structuredClone(input); (changed.htmlEvidence as any).tableSerializationVersion = "unchecked-simple";
    await expect(verifyCandidateFromRaw(rawPath, raw, changed, { python: "missing-python-must-not-run" })).rejects.toThrow("candidate_html_outline_marker_invalid");
  });

  it("binds the supplied proof hash to the actual helper tree", async () => {
    const changed = structuredClone(input); changed.htmlEvidence!.numberedOutlineEvidenceSha256 = "f".repeat(64);
    await expect(verifyCandidateFromRaw(rawPath, raw, changed, { python })).rejects.toThrow("candidate_html_evidence_does_not_match_raw_source");
  });

  it("cannot label the new text as legacy v4 to bypass the outline proof", async () => {
    const changed = structuredClone(input); delete changed.htmlEvidence!.tableSerializationVersion; delete changed.htmlEvidence!.numberedOutlineEvidenceSha256;
    await expect(verifyCandidateFromRaw(rawPath, raw, changed, { python })).rejects.toThrow("candidate_html_pages_do_not_match_raw_source");
  });

  it("still detects a real medical image even when its alt text is empty", async () => {
    const changedRaw = Buffer.from(raw.toString().replace("<table>", '<img src="medical-warning.png" alt=""><table>'));
    const changedFile = await inspect(changedRaw), changed = structuredClone(input);
    changed.fetched.sha256 = publicationHash(changedRaw); changed.fetched.bytes = changedRaw.length;
    await expect(verifyCandidateFromRaw(changedFile.path, changedRaw, changed, { python })).rejects.toThrow("candidate_html_pages_do_not_match_raw_source");
  });

  it("holds a real spanning dose matrix rather than discarding it", async () => {
    const changedRaw = Buffer.from(raw.toString().replace('<td>5.1.1</td>', '<td colspan="2">5.1.1</td>'));
    const changedFile = await inspect(changedRaw), changed = structuredClone(input);
    changed.fetched.sha256 = publicationHash(changedRaw); changed.fetched.bytes = changedRaw.length;
    await expect(verifyCandidateFromRaw(changedFile.path, changedRaw, changed, { python })).rejects.toThrow("raw_html_numbered_outline_capability_invalid");
  });

  it("keeps plain nonnested HTML on the legacy method without new markers", async () => {
    const plain = Buffer.from(raw.toString().replace(/<div class="toggle-inner">[\s\S]*?<\/div><\/div><\/div>/u,
      `<div class="toggle-inner"><p>${body}</p><table><tr><td>甲</td><td>乙</td></tr></table></div></div></div>`));
    const actual = await inspect(plain, false), changed = structuredClone(input);
    const text = [nameZh, nameEn, license, "合成處方藥"].join("\n") + "\n\n" + actual.report.normalizedSectionText;
    changed.fetched.sha256 = publicationHash(plain); changed.fetched.bytes = plain.length;
    changed.pages[0].text = text; changed.htmlEvidence!.canonicalTextSha256 = publicationHash(text);
    delete changed.htmlEvidence!.tableSerializationVersion; delete changed.htmlEvidence!.numberedOutlineEvidenceSha256;
    const proof = await verifyCandidateFromRaw(actual.path, plain, changed, { python });
    expect(proof.method).toBe("html_raw_dom_reparse_v4"); expect(proof).not.toHaveProperty("htmlNumberedOutlineEvidence");
    expect(actual.report.schemaVersion).toBe(4); expect(actual.report.tableSerializationVersion).toBe("tfda-simple-table-literal-v1");
    expect(await readFile(actual.path)).toEqual(plain);
  });
});
