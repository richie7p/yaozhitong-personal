/** Offline preparation of already acquired, explicitly indexed current paper PDFs. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, readdir, link, unlink, stat } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { evaluateTfdaSource, type TfdaFetchedArtifact, type TfdaSourceInput } from "./tfda-source-core.js";
import { hasSingleOfficialManufacturingProduct } from "./tfda-manufacturing-roles.js";
import { sameCandidateExceptEvaluation, storeImmutableCandidateInput } from "./prepare-tfda-sources.js";
import { deriveSerialPaperPdf, verifyParentPaperSource, verifyParentPaperEquivalentSources } from "./tfda-parent-paper-verification.js";
import { equivalentFetchedFromReceipt, type CurrentEquivalentSource } from "./tfda-current-paper-equivalence.js";
import { TFDA_PROTECTED_LICENSES, TFDA_PUBLICATION_PROJECT, TFDA_PUBLICATION_BUCKET, TFDA_PUBLICATION_SCHEMA,
  assertFreshTimestamp, assertOfficialPatientCategory, assertTechnicalPublicationSize, prepareTechnicalSource, publicationHash as hash, publicationRequire as must, safePublicationFailure, sameDocument,
  type PublicationDoc, type PublicationBatchItem, type PublicationIndexSnapshot, type PublicationManifest } from "./tfda-publication-core.js";

const run = promisify(execFile);
const json = async (path: string) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""));
const rawWithinLimit = async (path: string) => { must((await stat(path)).size <= 15_000_000, "parent_prepare_raw_exceeds_15mb"); const bytes = await readFile(path); must(bytes.length <= 15_000_000, "parent_prepare_raw_exceeds_15mb"); return bytes; };
const official = (value: string) => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && (u.hostname === "fda.gov.tw" || u.hostname.endsWith(".fda.gov.tw")); } catch { return false; } };
const urls = (value: unknown) => typeof value === "string" ? value.match(/https?:\/\/[^\s;<>"\u3000]+/gu) || [] : [];
const inside = (root: string, path: string) => { const value = relative(root, path); return !isAbsolute(value) && value !== ".." && !value.startsWith(".." + sep); };
const rowsByLicense = (rows: PublicationDoc[]) => { const result = new Map<string, PublicationDoc[]>(); for (const row of rows) { const key = row["許可證字號"]; result.set(key, [...(result.get(key) || []), row]); } return result; };
export interface ParentLicenseSelection { path: string; sha256: string; licenses: readonly string[] }
export function parseParentLicenseSelection(bytes: Buffer): readonly string[] {
  must(bytes.length <= 2_000_000, "parent_license_list_exceeds_2000000_bytes");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")); } catch { must(false, "parent_license_list_invalid_json"); }
  must(Array.isArray(value) && value.length > 0 && value.length <= 5000 && value.every((license) =>
    typeof license === "string" && /^(?:衛署|衛部|內衛)[\p{Script=Han}]{1,12}字第(?:R\d{5,7}|\d{6,8})號$/u.test(license)),
    "parent_license_list_requires_1_to_5000_complete_licenses");
  must(new Set(value).size === value.length, "parent_license_list_duplicate_complete_license");
  return Object.freeze([...value]);
}
export async function readParentLicenseSelection(path: string): Promise<ParentLicenseSelection> {
  const absolute = resolve(path); must((await stat(absolute)).size <= 2_000_000, "parent_license_list_exceeds_2000000_bytes");
  const bytes = await readFile(absolute);
  return Object.freeze({ path: absolute, sha256: hash(bytes), licenses: parseParentLicenseSelection(bytes) });
}
export async function assertParentLicenseSelectionUnchanged(selection: ParentLicenseSelection) {
  must(hash(await readFile(selection.path)) === selection.sha256, "parent_license_list_changed_during_evaluation");
}
export function fetchedFromSuccessfulReceipt(record: any, format: "html" | "pdf"): TfdaFetchedArtifact {
  const requested = record.requestedUrl || record.sourceUrl, final = record.finalUrl;
  must(record.httpStatus === 200 && official(requested) && official(final), "parent_prepare_successful_official_HTTP200_receipt_required");
  if (record.redirectChain !== undefined && record.redirects !== undefined)
    must(sameDocument(record.redirectChain, record.redirects), "parent_prepare_conflicting_redirect_receipts");
  const hops = record.redirectChain ?? record.redirects ?? [];
  must(Array.isArray(hops), "parent_prepare_explicit_redirect_receipt_required");
  const sameUrl = (left: string, right: string) => new URL(left).href === new URL(right).href;
  const chain: string[] = []; let expected = requested;
  for (const hop of hops) {
    must(hop && typeof hop === "object" && official(hop.from) && official(hop.to) &&
      [301, 302, 303, 307, 308].includes(hop.httpStatus ?? hop.status) &&
      (hop.httpStatus === undefined || hop.status === undefined || hop.httpStatus === hop.status) && sameUrl(hop.from, expected),
      "parent_prepare_noncontiguous_or_unproven_redirect_receipt");
    if (!chain.length) chain.push(hop.from); chain.push(hop.to); expected = hop.to;
  }
  must(sameUrl(expected, final) && (hops.length > 0 || sameUrl(requested, final)), "parent_prepare_missing_actual_redirect_receipt");
  if (!chain.length) chain.push(requested);
  return { requestedUrl: requested, finalUrl: final, redirectChain: chain,
    retrievedAt: record.fetchedAt || record.at, sha256: record.sourceBlobSha256 || record.sha256, bytes: record.bytes,
    mediaType: record.contentType || record.mediaType, contentSignature: format };
}
async function immutable(path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"); await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp-" + randomUUID();
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try { await link(temporary, path); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    must((await readFile(path)).equals(bytes), "immutable_parent_paper_file_conflict");
  } finally { await unlink(temporary).catch((error: any) => { if (error.code !== "ENOENT") throw error; }); }
}
async function acquiredPaperRows(archive: string, python: string) {
  const program = "import json,pathlib,sqlite3,sys; p=pathlib.Path(sys.argv[1]).resolve(); c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True); c.execute('PRAGMA query_only=ON'); q=\"select job_json,result_json from assets where status like 'downloaded_%' and exists(select 1 from json_each(job_json,'$.cohorts') where value='current_paper')\"; print(json.dumps([{'job':json.loads(a),'result':json.loads(b)} for a,b in c.execute(q)],ensure_ascii=False)); c.close()";
  const result = await run(python, ["-X", "utf8", "-c", program, join(archive, "archive-checkpoint.sqlite3")], {
    timeout: 60_000, maxBuffer: 50_000_000, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  const rows = JSON.parse(result.stdout); must(Array.isArray(rows), "archive_readonly_projection_invalid"); return rows;
}
export async function main(args = process.argv.slice(2)) {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    must(["--inventory", "--corpus", "--archive", "--output", "--protected", "--python", "--limit", "--license", "--license-list", "--parent-paper-mode"].includes(args[i]) &&
      !!args[i + 1] && !options[args[i]], "parent_prepare_invalid_arguments"); options[args[i]] = args[i + 1];
  }
  must(["--inventory", "--corpus", "--archive", "--output", "--protected"].every((key) => options[key]), "parent_prepare_explicit_paths_required");
  const parentPaperMode = options["--parent-paper-mode"] || "strict-v2";
  must(["strict-v2", "byte-equivalent-v1"].includes(parentPaperMode), "parent_prepare_unknown_parent_paper_mode");
  must(!(options["--license"] && options["--license-list"]), "parent_prepare_license_and_list_mutually_exclusive");
  const licenseSelection = options["--license-list"] ? await readParentLicenseSelection(options["--license-list"]) : undefined;
  const selectedLicenses = licenseSelection ? new Set(licenseSelection.licenses) : undefined;
  const inventory = resolve(options["--inventory"]), corpus = resolve(options["--corpus"]), archive = resolve(options["--archive"]), output = resolve(options["--output"]);
  must([corpus, archive, inventory].every((path) => !inside(path, output) && !inside(output, path)), "parent_prepare_separate_output_required");
  const limit = Number(options["--limit"] || 100), python = options["--python"] || "python";
  must(Number.isSafeInteger(limit) && limit > 0 && limit <= 5000, "parent_prepare_limit_must_be_1_to_5000");
  const catalog = await json(join(inventory, "info36.json")), index = await json(join(inventory, "info39.json"));
  const catalogMap = rowsByLicense(catalog), indexMap = rowsByLicense(index), snapshots: PublicationIndexSnapshot[] = [];
  const evidence = new Map<number, any>();
  for (const infoId of [36, 39] as const) {
    const path = join(inventory, `info${infoId}.json`), evidencePath = join(inventory, `info${infoId}.evidence.json`), raw = await readFile(path), evidenceBytes = await readFile(evidencePath);
    const proof = JSON.parse(evidenceBytes.toString("utf8"));
    must(proof.infoId === infoId && proof.jsonSha256 === hash(raw) && proof.jsonBytes === raw.length && proof.httpStatus === 200 &&
      official(proof.requestedUrl) && official(proof.finalUrl) && Array.isArray(proof.redirects) && proof.redirects.every((hop: any) => official(hop.fromUrl) && official(hop.toUrl)) &&
      (!proof.legacyBlockedRedirect || proof.legacyBlockedRedirect.followed === false), "parent_prepare_official_index_provenance_invalid");
    assertFreshTimestamp(proof.retrievedAt, Date.now(), "parent_prepare_official_index_stale");
    must((infoId === 36 ? catalog : index).length === proof.rows, "parent_prepare_official_index_row_count_mismatch");
    snapshots.push({ infoId, path, sha256: hash(raw), evidencePath, evidenceSha256: hash(evidenceBytes) }); evidence.set(infoId, proof);
  }
  const protectedData = await json(resolve(options["--protected"])), protectedLicenses = new Set<string>(TFDA_PROTECTED_LICENSES);
  for (const item of protectedData.leaflets || []) if (item.status === "published") protectedLicenses.add(item.licenseNo);
  await mkdir(output, { recursive: true });
  const priorInputs = await readdir(join(output, "inputs")).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; });
  const counts: Record<string, number> = {}, results: any[] = [], items: PublicationBatchItem[] = [], seen = new Set<string>();
  const increment = (key: string) => { counts[key] = (counts[key] || 0) + 1; };
  const rows = (await acquiredPaperRows(archive, python)).sort((left, right) => String(left.job.sourceUrl).localeCompare(String(right.job.sourceUrl)));
  const archiveRowsByUrl = new Map<string, any[]>();
  for (const row of rows) archiveRowsByUrl.set(row.job.sourceUrl, [...(archiveRowsByUrl.get(row.job.sourceUrl) || []), row]);
  let attempted = 0;
  for (const row of rows) {
    let { job, result } = row;
    const current = job.parents.filter((parent: any) => parent.discoveryType === "current_paper" && parent.licenseState === "active");
    const licenses = [...new Set<string>(current.map((parent: any) => parent.fullLicense))];
    if (options["--license"] && !licenses.includes(options["--license"])) continue;
    if (selectedLicenses && !licenses.some((license) => selectedLicenses.has(license))) continue;
    if (licenses.length !== 1 || job.parents.some((parent: any) => parent.fullLicense && parent.fullLicense !== licenses[0]) ||
      job.origin === "derived_known_official_license_route" || job.parents.some((parent: any) => parent.association === "no_Info39_association")) { increment("ambiguous_or_unindexed_parent_scope"); continue; }
    const licenseNo = licenses[0];
    if (protectedLicenses.has(licenseNo)) { increment("existing_publication_preserved"); continue; }
    if (parentPaperMode === "strict-v2" && ((result.archiveMediaKind || result.sourceType) !== "pdf" || result.rawVersions || !result.sourceBlobSha256 || result.bytes > 15_000_000)) { increment("not_single_runtime_sized_pdf_raw"); continue; }
    const key = parentPaperMode === "byte-equivalent-v1" ? licenseNo : licenseNo + "|" + result.sourceBlobSha256;
    if (seen.has(key)) { increment("duplicate_product_raw"); continue; } seen.add(key);
    if (attempted >= limit) { increment("deferred_by_limit"); continue; } attempted++;
    const record: any = { licenseNo, childUrl: job.sourceUrl, rawSha256: result.sourceBlobSha256, publicationEligible: false };
    try {
      const catalogRows = catalogMap.get(licenseNo) || [], indexRows = indexMap.get(licenseNo) || [];
      assertOfficialPatientCategory(catalogRows, licenseNo);
      const parentKeys = [...new Set(current.map((parent: any) => parent.parentUrlHash))];
      must(parentKeys.length === 1 && typeof parentKeys[0] === "string" && /^[a-f0-9]{64}$/u.test(parentKeys[0]), "parent_prepare_unique_parent_required");
      const parentRecord = await json(join(corpus, "records", parentKeys[0] + ".json"));
      const parentRawPath = resolve(corpus, parentRecord.blobPath);
      must(inside(corpus, parentRawPath), "parent_prepare_raw_path_outside_source_corpus");
      const parentRaw = await rawWithinLimit(parentRawPath);
      const aliases: CurrentEquivalentSource[] = [];
      if (parentPaperMode === "byte-equivalent-v1") {
        const helper = fileURLToPath(new URL("./inspect-tfda-parent-paper.py", import.meta.url));
        const inspection = JSON.parse((await run(python, ["-X", "utf8", helper, "--raw", parentRawPath, "--source-url", parentRecord.finalUrl], {
          timeout: 45_000, maxBuffer: 8_000_000, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        })).stdout.trim());
        must(inspection.rawSha256 === hash(parentRaw) && inspection.associationValid === false &&
          sameDocument(inspection.invalidReasons, ["current_paper_url_count_not_one"]) && Array.isArray(inspection.currentPaperUrls) &&
          inspection.currentPaperUrls.length >= 2 && inspection.currentPaperUrls.length <= 50, "parent_prepare_complete_equivalent_family_dom_required");
        for (const url of inspection.currentPaperUrls) {
          const matches = archiveRowsByUrl.get(url) || [];
          must(matches.length === 1, "parent_prepare_every_current_alias_original_receipt_required");
          const envelope = matches[0], aliasPath = resolve(archive, envelope.result.blobPath);
          must(inside(archive, aliasPath), "parent_prepare_alias_raw_path_outside_archive");
          const aliasRaw = await rawWithinLimit(aliasPath), fetched = equivalentFetchedFromReceipt(envelope.result);
          must(hash(aliasRaw) === fetched.sha256 && aliasRaw.length === fetched.bytes, "parent_prepare_alias_original_raw_binding_mismatch");
          const metadataPath = join(output, "receipts", hash(JSON.stringify(envelope)) + ".json");
          await immutable(metadataPath, envelope);
          aliases.push({ fullLicense: licenseNo, rawSourcePath: aliasPath, rawSourceSha256: hash(aliasRaw), rawMetadataPath: metadataPath,
            rawMetadataSha256: hash(await readFile(metadataPath)), fetched, allArchiveRoles: envelope.job.parents });
        }
        // Only after the complete DOM family is present may its first literal alias represent the shared bytes.
        ({ job, result } = archiveRowsByUrl.get(inspection.currentPaperUrls[0])![0]);
        record.childUrl = job.sourceUrl; record.rawSha256 = result.sourceBlobSha256;
      }
      const rawPath = resolve(archive, result.blobPath);
      must(inside(archive, rawPath), "parent_prepare_raw_path_outside_source_corpus");
      const raw = await rawWithinLimit(rawPath);
      must(hash(raw) === result.sourceBlobSha256 && raw.length === result.bytes && hash(parentRaw) === parentRecord.sourceBlobSha256 &&
        current.every((parent: any) => parent.parentRawSha256 === hash(parentRaw)), "parent_prepare_acquired_raw_binding_mismatch");
      must((result.requestedUrl || result.sourceUrl) === job.sourceUrl, "parent_prepare_child_download_url_mismatch");
      const input: TfdaSourceInput = { licenseNo, checkedAt: new Date().toISOString(), asOfDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(),
        officialCategory: catalogRows[0]["藥品類別"], catalogCheckedAt: evidence.get(36).retrievedAt, indexCheckedAt: evidence.get(39).retrievedAt,
        catalogRows: catalogRows.map((row) => ({ licenseNo, nameZh: row["中文品名"] || "", nameEn: row["英文品名"] || "", form: row["劑型"] || "", manufacturer: row["製造商名稱"] || "", effectiveUntil: row["有效日期"] || "", revoked: !!String(row["註銷狀態"] || "").trim() })),
        indexRows: indexRows.map((row) => ({ licenseNo, nameZh: row["中文品名"] || "", nameEn: row["英文品名"] || "", urls: urls(row["仿單圖檔連結"]) })),
        fetched: fetchedFromSuccessfulReceipt(result, "pdf"), format: "pdf", numPages: 0, pages: [] };
      if (hasSingleOfficialManufacturingProduct(licenseNo, input.catalogRows, catalogRows))
        input.catalogManufacturingRecords = structuredClone(catalogRows) as Record<string, string | null>[];
      const parentSource = { rawSourcePath: parentRawPath, rawSourceSha256: hash(parentRaw), fetched: fetchedFromSuccessfulReceipt(parentRecord, "html"),
        ...(parentPaperMode === "byte-equivalent-v1" ? { currentEquivalentSources: aliases } : {}) };
      const verified = parentPaperMode === "byte-equivalent-v1" ?
        await verifyParentPaperEquivalentSources({ ...parentSource, currentEquivalentSources: aliases }, input, parentRawPath, parentRaw, catalogRows, indexRows, snapshots, { python }) :
        await verifyParentPaperSource(parentSource, input, parentRawPath, parentRaw, catalogRows, indexRows, snapshots, { python });
      input.officialAssociation = verified.association;
      const pdf = await deriveSerialPaperPdf(rawPath, raw, { python }); input.numPages = pdf.numPages; input.pages = pdf.pages;
      const assessment = evaluateTfdaSource(input);
      let previousPath: string | undefined;
      for (const filename of priorInputs) if (filename.startsWith(hash(licenseNo) + "-") && filename.endsWith(".json")) {
        const path = join(output, "inputs", filename);
        if (sameCandidateExceptEvaluation(await json(path), input)) { previousPath = path; break; }
      }
      const stored = await storeImmutableCandidateInput(output, input, previousPath);
      const assessmentValue = { inputSha256: stored.candidateInputSha256, assessment, parentVerification: verified.proof, rawVerification: pdf.rawVerification,
        rawMetadataReceipts: { parent: parentRecord, child: result } };
      await immutable(join(output, "assessments", hash(JSON.stringify(assessmentValue)) + ".json"), assessmentValue);
      record.assessment = { status: assessment.status, eligibleTechnical: assessment.eligibleTechnical, runtimeCompatible: assessment.runtimeCompatible, reasons: assessment.reasons };
      if (assessment.eligibleTechnical && assessment.runtimeCompatible) {
        const item = { fullLicense: licenseNo, ...stored, rawSourcePath: rawPath, rawSourceSha256: hash(raw), parentSource };
        const source = prepareTechnicalSource(item, input, raw); source.parentVerification = verified.proof; source.rawVerification = pdf.rawVerification;
        assertTechnicalPublicationSize(source); items.push(item); increment("technically_eligible_runtime_compatible");
      } else increment("needs_source_correction");
    } catch (error) { record.failure = safePublicationFailure(error); increment("technical_validation_blocked"); }
    results.push(record);
  }
  if (licenseSelection) {
    await assertParentLicenseSelectionUnchanged(licenseSelection);
  }
  const manifests: string[] = [];
  for (let offset = 0; offset < items.length; offset += 50) {
    const chunk = items.slice(offset, offset + 50), batchId = "tfda-parent-" + hash(JSON.stringify({ snapshots, items: chunk })).slice(0, 24);
    const manifest: PublicationManifest = { schema: TFDA_PUBLICATION_SCHEMA, batchId, project: TFDA_PUBLICATION_PROJECT, bucket: TFDA_PUBLICATION_BUCKET, indexSnapshots: snapshots, items: chunk };
    const path = join(output, "batches", batchId + ".json"); await immutable(path, manifest); manifests.push(path);
  }
  const summary = { schema: "tfda-parent-paper-preparation/v1", at: new Date().toISOString(), attempted, eligible: items.length, counts, results, manifests,
    acquiredCurrentPaperRows: rows.length, selection: { license: options["--license"] || null, limit,
      ...(licenseSelection ? { licenseList: { path: licenseSelection.path, sha256: licenseSelection.sha256, count: licenseSelection.licenses.length } } : {}) },
    evaluationCoverageStatus: counts.deferred_by_limit ? "partial_bounded_evaluation" : options["--license"] || licenseSelection ? "explicit_license_selection_evaluated" : "selected_existing_archive_candidates_evaluated",
    coverageNotice: "Only acquired current-paper candidates selected by these filters were evaluated; failures/drafts/archive-only items are not published source coverage.",
    netAdditionalCoverage: "Not established by offline preparation. Wait for main completion, then reprepare against fresh actual published pointers before any parent publication.",
    requiredPublisherOption: "--parent-paper-mode " + parentPaperMode, humanReviewed: false, clinicalReviewed: false, aiCalls: 0, cloudWrites: 0, networkRequests: 0, maxConcurrentPdfChildProcesses: 1 };
  const summaryPath = join(output, "summaries", hash(JSON.stringify(summary)) + ".json"); await immutable(summaryPath, summary);
  console.log(JSON.stringify({ ...summary, summaryPath })); return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(JSON.stringify(safePublicationFailure(error))); process.exitCode = 1; });
