import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { officialCategoryDisposition, sameCandidateExceptEvaluation, storeImmutableCandidateInput } from "../tools/prepare-tfda-sources";
import { assertOfficialPatientCategory, publicationHash } from "../tools/tfda-publication-core";
import type { TfdaSourceInput } from "../tools/tfda-source-core";

describe("official category source selection", () => {
  it("archives official raw-material rows before preparing a publication batch", () => {
    expect(officialCategoryDisposition({ catalogRows: [{ record: { 藥品類別: "製劑原料" } }] })).toBe("archive_only_raw_material");
    expect(officialCategoryDisposition({ catalogRows: [{ record: { 藥品類別: "本藥須由醫師處方使用" } }] })).toBe("patient_candidate");
    expect(officialCategoryDisposition({ catalogRows: [{ record: {} }] })).toBe("archive_only_unconfirmed_category");
  });
  it("fails closed for missing, contradictory, or spoofed official category metadata", () => {
    const licenseNo = "SYNTHETIC-LICENSE";
    const rows = [{ 許可證字號: licenseNo, 藥品類別: "合成處方藥" }];
    expect(assertOfficialPatientCategory(rows, licenseNo)).toBe("合成處方藥");
    expect(() => assertOfficialPatientCategory(rows, licenseNo, "另一個合成類別")).toThrow("candidate_official_category_mismatch");
    expect(() => assertOfficialPatientCategory([{ 許可證字號: licenseNo }], licenseNo)).toThrow("official_product_category_missing");
    expect(() => assertOfficialPatientCategory([...rows, { 許可證字號: licenseNo, 藥品類別: "原料藥" }], licenseNo)).toThrow("official_raw_material_source_not_patient_leaflet");
  });
  it("can retain old candidate bytes when only evaluation controls changed", () => {
    const old = { checkedAt: "2026-10-21T00:00:00Z", asOfDate: "2026-10-21", pages: [{ page: 1, text: "SYNTHETIC exact source" }] } as TfdaSourceInput;
    expect(sameCandidateExceptEvaluation(old, { ...old, checkedAt: "2026-10-21T01:00:00Z" })).toBe(true);
    expect(sameCandidateExceptEvaluation(old, { ...old, asOfDate: "2026-10-22" })).toBe(false);
    expect(sameCandidateExceptEvaluation(old, { ...old, pages: [{ page: 1, text: "SYNTHETIC changed source" }] })).toBe(false);
  });
  it("keeps historical input files and manifest bytes when category or expiry-evaluation day changes", async () => {
    const output = await mkdtemp(join(tmpdir(), "synthetic-tfda-immutable-input-"));
    try {
      const input = { licenseNo: "SYNTHETIC-FULL-LICENSE", checkedAt: "2026-10-21T00:00:00Z", asOfDate: "2026-10-21",
        officialCategory: "合成處方藥", pages: [{ page: 1, text: "SYNTHETIC exact full source" }] } as TfdaSourceInput;
      const legacy = join(output, "inputs", publicationHash(input.licenseNo) + ".json"), historicalBytes = Buffer.from(JSON.stringify(input) + "\n");
      await mkdir(join(output, "inputs")); await writeFile(legacy, historicalBytes);
      const manifestPath = join(output, "historical-batch.json"), manifestBytes = Buffer.from(JSON.stringify({ candidateInputPath: legacy, candidateInputSha256: publicationHash(historicalBytes) }));
      await writeFile(manifestPath, manifestBytes);
      const first = await storeImmutableCandidateInput(output, { ...input, checkedAt: "2026-10-21T01:00:00Z" });
      expect(first.candidateInputPath).toContain(publicationHash(historicalBytes));
      expect(first.candidateInputPath).not.toBe(legacy);
      expect(await readFile(first.candidateInputPath)).toEqual(historicalBytes);
      const changedCategory = await storeImmutableCandidateInput(output, { ...input, officialCategory: "另一合成類別" }, first.candidateInputPath);
      const changedDay = await storeImmutableCandidateInput(output, { ...input, asOfDate: "2026-10-22" }, first.candidateInputPath);
      expect(new Set([first.candidateInputPath, changedCategory.candidateInputPath, changedDay.candidateInputPath]).size).toBe(3);
      for (const stored of [first, changedCategory, changedDay]) expect(publicationHash(await readFile(stored.candidateInputPath))).toBe(stored.candidateInputSha256);
      expect(JSON.parse(await readFile(changedDay.candidateInputPath, "utf8")).asOfDate).toBe("2026-10-22");
      expect(await readFile(first.candidateInputPath)).toEqual(historicalBytes);
      expect(await readFile(legacy)).toEqual(historicalBytes);
      expect(await readFile(manifestPath)).toEqual(manifestBytes);
      expect(await storeImmutableCandidateInput(output, { ...input, checkedAt: "2026-10-21T02:00:00Z" }, first.candidateInputPath)).toEqual(first);
    } finally { await rm(output, { recursive: true, force: true }); }
  });
  it("refuses an occupied content-addressed path whose bytes differ instead of overwriting it", async () => {
    const output = await mkdtemp(join(tmpdir(), "synthetic-tfda-input-conflict-"));
    try {
      const input = { licenseNo: "SYNTHETIC-FULL-LICENSE", checkedAt: "2026-10-21T00:00:00Z", asOfDate: "2026-10-21", pages: [] } as unknown as TfdaSourceInput;
      const stored = await storeImmutableCandidateInput(output, input), tampered = Buffer.from("SYNTHETIC conflicting bytes");
      await writeFile(stored.candidateInputPath, tampered);
      await expect(storeImmutableCandidateInput(output, input)).rejects.toThrow("immutable_candidate_input_content_conflict");
      expect(await readFile(stored.candidateInputPath)).toEqual(tampered);
    } finally { await rm(output, { recursive: true, force: true }); }
  });
});
