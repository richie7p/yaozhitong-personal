/** Local-only preparation. Never loads .env, application Domain, AI or Firebase. */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateTfdaSource, normalizeTfdaSourceText, type TfdaSourceInput, type TfdaFetchedArtifact } from "./tfda-source-core.js";

const runFile = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = async (path: string) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""));
const optional = async (path: string): Promise<any | null> => {
  try { return await json(path); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
};
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}
const day = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const urls = (value: unknown): string[] => typeof value === "string" ? value.match(/https?:\/\/[^\s;<>"\u3000]+/gu) || [] : [];

async function extractOne(path: string) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = await readFile(path);
  if (bytes.length > 15_000_000 || bytes.subarray(0, 5).toString() !== "%PDF-") throw Error("invalid_pdf_bytes");
  const task = getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true,
    cMapUrl: resolve("node_modules/pdfjs-dist/cmaps").replace(/\\/gu, "/") + "/", cMapPacked: true,
    standardFontDataUrl: resolve("node_modules/pdfjs-dist/standard_fonts").replace(/\\/gu, "/") + "/", verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 200) return { numPages: pdf.numPages, pages: [], error: "over_200_physical_pages" };
    const pages = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ") : "").join("").trim();
      pages.push({ page, text });
    }
    return { numPages: pdf.numPages, pages, parser: "pdfjs-dist", rawSha256: hash(bytes), rawBytes: bytes.length };
  } finally { await task.destroy(); }
}

/** Blank pages still occupy their physical position in both engine inventories. */
export function completePhysicalPageInventories(independent: any, canonical: any): boolean {
  return Number.isSafeInteger(canonical?.numPages) && canonical.numPages > 0 &&
    independent?.allPhysicalPagesExtracted === true &&
    independent.physicalPageCount === canonical.numPages &&
    Array.isArray(canonical.pages) && canonical.pages.length === canonical.numPages &&
    canonical.pages.every((page: any, index: number) => page.page === index + 1) &&
    Array.isArray(independent.pages) && independent.pages.length === canonical.numPages &&
    independent.pages.every((page: any, index: number) => page.page === index + 1);
}

function fetched(record: any): TfdaFetchedArtifact {
  const chain: string[] = [record.requestedUrl || record.sourceUrl];
  for (const hop of record.redirectChain || record.redirects || []) {
    if (typeof hop === "string") { if (chain.at(-1) !== hop) chain.push(hop); }
    else { if (chain.at(-1) !== hop.from) chain.push(hop.from); chain.push(hop.to); }
  }
  if (chain.at(-1) !== record.finalUrl) chain.push(record.finalUrl);
  return {
    requestedUrl: record.requestedUrl || record.sourceUrl, finalUrl: record.finalUrl,
    redirectChain: chain, retrievedAt: record.fetchedAt || record.at,
    sha256: record.sha256 || record.sourceBlobSha256, bytes: record.bytes,
    mediaType: record.mediaType || record.contentType, contentSignature: record.sourceType === "pdf" ? "pdf" : record.sourceType === "html" ? "html" : "unknown",
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--extract-one" && args.length === 2) {
    try { console.log(JSON.stringify(await extractOne(resolve(args[1])))); }
    catch (error: any) { console.log(JSON.stringify({ error: String(error.code || error.message).slice(0, 100), pages: [], numPages: 0 })); process.exitCode = 1; }
    return;
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--inventory", "--corpus", "--output", "--protected", "--limit"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error("invalid_arguments");
    options[args[i]] = args[i + 1];
  }
  if (!["--inventory", "--corpus", "--output"].every((key) => options[key])) throw Error("requires_inventory_corpus_output");
  const inventory = resolve(options["--inventory"]), corpus = resolve(options["--corpus"]), output = resolve(options["--output"]);
  const limit = Number(options["--limit"] || "100000");
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error("invalid_limit");
  await mkdir(output, { recursive: true });
  const products = (await readFile(join(inventory, "active-candidates.ndjson"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const evidence36 = await json(join(inventory, "info36.evidence.json")), evidence39 = await json(join(inventory, "info39.evidence.json"));
  const indexSnapshots = [];
  for (const infoId of [36, 39]) {
    const path = join(inventory, `info${infoId}.json`), evidencePath = join(inventory, `info${infoId}.evidence.json`);
    indexSnapshots.push({ infoId, path, sha256: hash(await readFile(path)), evidencePath, evidenceSha256: hash(await readFile(evidencePath)) });
  }
  const toolHash = hash(Buffer.concat([await readFile(fileURLToPath(import.meta.url)), await readFile(new URL("./tfda-source-core.ts", import.meta.url))]));
  const protectedData = options["--protected"] ? await json(resolve(options["--protected"])) : { leaflets: [] };
  const protectedLicenses = new Set((protectedData.leaflets || []).filter((item: any) => item.status === "published").map((item: any) => item.licenseNo));
  const counts: Record<string, number> = {}, reasons: Record<string, number> = {};
  const eligible: any[] = [];
  let processed = 0, reused = 0;
  for (const product of products) {
    const licenseNo = product.fullLicense;
    if (protectedLicenses.has(licenseNo)) { counts.existing_published_preserved = (counts.existing_published_preserved || 0) + 1; continue; }
    const records: any[] = [];
    let branchesReady = true;
    for (const sourceUrl of [...new Set<string>(product.sourceUrlsExactOrder)]) {
      const record = await optional(join(corpus, "records", hash(sourceUrl) + ".json"));
      if (!record || !record.sourceBlobSha256) { branchesReady = false; continue; }
      if ((record.requestedUrl || record.sourceUrl) !== sourceUrl || record.urlHash !== hash(sourceUrl)) throw Error("download_record_url_binding_mismatch");
      records.push(record);
    }
    if (!records.length) { counts.awaiting_download = (counts.awaiting_download || 0) + 1; continue; }
    if (processed >= limit) { counts.deferred_by_limit = (counts.deferred_by_limit || 0) + 1; continue; }
    const record = records[0];
    const rawPath = resolve(corpus, record.blobPath);
    if (!rawPath.startsWith(corpus + "/") && !rawPath.startsWith(corpus + "\\")) throw Error("raw_path_outside_corpus");
    const raw = await readFile(rawPath);
    if (hash(raw) !== record.sourceBlobSha256) throw Error("raw_object_integrity_failure");
    const extractionPath = record.extractionPath && resolve(corpus, record.extractionPath);
    const extraction = extractionPath ? await optional(extractionPath) : null;
    const independent = extraction?.sourceBlobSha256 === record.sourceBlobSha256 && extraction?.urlHash === record.urlHash ? extraction : null;
    // A seeded original is useful for acquisition recovery, but must receive the
    // current independent extraction before an expensive canonical PDF parse.
    const currentExtraction = record.sourceType === "html"
      ? independent?.parserVersion === "tfda-complete-dom-v4"
      : independent?.parserVersion === "tfda-pdf-independent-v3";
    if (!currentExtraction) {
      counts.awaiting_current_extraction = (counts.awaiting_current_extraction || 0) + 1;
      continue;
    }
    processed++;
    const fingerprint = hash(JSON.stringify({ toolHash, evaluationDay: day(), indexes: indexSnapshots.map((s) => [s.sha256, s.evidenceSha256]), records: records.map((r) => [r.sourceUrl, r.sourceBlobSha256, r.parserVersion, r.fetchedAt, r.finalUrl, r.redirectChain]), extractionHash: extractionPath ? hash(await readFile(extractionPath)) : null, branchesReady }));
    const destination = join(output, "assessments", hash(licenseNo) + ".json");
    let prepared = await optional(destination);
    const retryCanonical = prepared?.canonicalRetry?.attempts < 2 && Date.now() >= prepared.canonicalRetry.nextAfter;
    if (prepared?.fingerprint === fingerprint && !retryCanonical) reused++;
    else {
      const input: TfdaSourceInput = {
        licenseNo, checkedAt: new Date().toISOString(), asOfDate: day(),
        catalogCheckedAt: evidence36.retrievedAt, indexCheckedAt: evidence39.retrievedAt,
        catalogRows: product.catalogRows.map((row: any) => row.record).map((r: any) => ({ licenseNo: r["許可證字號"], nameZh: r["中文品名"] || "", nameEn: r["英文品名"] || "", form: r["劑型"] || "", manufacturer: r["製造商名稱"] || "", effectiveUntil: r["有效日期"] || "", revoked: !!String(r["註銷狀態"] || "").trim() })),
        indexRows: product.indexRows.map((row: any) => row.record).map((r: any) => ({ licenseNo: r["許可證字號"], nameZh: r["中文品名"] || "", nameEn: r["英文品名"] || "", urls: urls(r["仿單圖檔連結"]) })),
        fetched: fetched(record), format: record.sourceType === "html" ? "html" : "pdf", numPages: 0, pages: [],
        sameSourceArtifacts: records.slice(1).map(fetched),
      };
      let preparationError: string | null = independent ? null : "independent_extraction_binding_missing_or_invalid";
      let canonicalRetry: { attempts: number; nextAfter: number } | undefined;
      if (record.sourceType === "pdf") {
        const cachePath = join(output, "pdfjs", record.sourceBlobSha256 + ".json");
        let canonical = await optional(cachePath);
        const priorAttempts = canonical?.failedAttempts || 0;
        if (canonical?.error === "bounded_pdfjs_extraction_failed" && priorAttempts < 2 && Date.now() >= (canonical.nextRetryAfter || 0)) canonical = null;
        if (!canonical) {
          try {
            const result = await runFile(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--extract-one", rawPath], { timeout: 60_000, maxBuffer: 8_000_000, windowsHide: true, encoding: "utf8" });
            canonical = JSON.parse(result.stdout.trim());
          } catch { canonical = { numPages: independent?.physicalPageCount || 0, pages: [], error: "bounded_pdfjs_extraction_failed", failedAttempts: priorAttempts + 1, nextRetryAfter: Date.now() + 60_000 }; }
          await atomic(cachePath, canonical);
        }
        if (!canonical.error && canonical.rawSha256 !== record.sourceBlobSha256) canonical = { numPages: 0, pages: [], error: "canonical_extraction_raw_binding_mismatch" };
        input.numPages = canonical.numPages;
        const physicalPagesMatch = completePhysicalPageInventories(independent, canonical);
        input.pages = (physicalPagesMatch ? canonical.pages : []).map((page: any) => {
          const peer = independent?.pages?.find((p: any) => p.page === page.page);
          return { page: page.page, text: page.text, independentText: peer?.text, additionalIndependentText: peer?.pypdfText, embeddedImages: peer?.imageCount, hasLargeUnverifiedImage: peer ? peer.imageLarge || peer.imageGeometryUnknown : undefined, hasUnverifiedStructure: peer?.hasUnverifiedStructure, structureEvidence: peer?.structureEvidence };
        });
        preparationError = canonical.error || preparationError;
        if (!physicalPagesMatch) preparationError = "physical_page_inventories_disagree_or_incomplete";
        if (canonical.error === "bounded_pdfjs_extraction_failed") canonicalRetry = { attempts: canonical.failedAttempts || 1, nextAfter: canonical.nextRetryAfter || 0 };
      } else if (record.sourceType === "html") {
        const fields = independent?.identityFields || {};
        const prefix = [fields["中文品名"], fields["英文品名"], fields["許可證號"], fields["藥品類別"]].map((value) => value || "").join("\n");
        const text = prefix + "\n\n" + (independent?.normalizedSectionText || "");
        // Only explicit literal TAB/cell + newline/row conservation can authorize
        // simple HTML tables. Spans, nested data tables and media stay pending.
        const unverified = independent?.hasUnverifiedNonTextContent !== false ||
          independent?.simpleTablesConserved !== true || independent?.complexTableCount !== 0 ||
          independent?.parserVersion !== "tfda-complete-dom-v4" ||
          independent?.unaccountedMainBlockCount !== 0 || independent?.allMainBlocksAccounted !== true ||
          independent?.tableSerializationVersion !== "tfda-simple-table-literal-v1";
        const documentLicenseMatches = typeof fields["許可證號"] === "string" && normalizeTfdaSourceText(fields["許可證號"]) === normalizeTfdaSourceText(licenseNo);
        input.numPages = 1; input.pages = [{ page: 1, text, embeddedImages: independent?.nonTextImages?.length || 0, hasLargeUnverifiedImage: unverified }];
        input.htmlEvidence = { completeMainDocument: independent?.fullDomConserved === true && documentLicenseMatches, domConservationPassed: independent?.fullDomConserved === true && documentLicenseMatches, canonicalTextSha256: hash(text), sectionCount: independent?.sections?.length || 0, hasUnverifiedNonTextContent: unverified };
        if (!documentLicenseMatches) preparationError = "html_current_license_field_missing_or_mismatch";
      }
      const assessment = evaluateTfdaSource(input);
      const candidateInputPath = join(output, "inputs", hash(licenseNo) + ".json");
      await atomic(candidateInputPath, input);
      prepared = { schema: "tfda-source-preparation/v1", fingerprint, fullLicense: licenseNo, branchesReady, preparationError, canonicalRetry, candidateInputPath, candidateInputSha256: hash(await readFile(candidateInputPath)), rawSourcePath: rawPath, rawSourceSha256: hash(raw), assessment };
      await atomic(destination, prepared);
    }
    const label = prepared.assessment.eligibleTechnical && prepared.assessment.runtimeCompatible ? "technically_eligible_runtime_compatible" : prepared.assessment.status === "technically_eligible" ? "source_complete_over_model_budget" : prepared.assessment.status;
    counts[label] = (counts[label] || 0) + 1;
    for (const reason of prepared.assessment.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
    if (label === "technically_eligible_runtime_compatible") eligible.push({ fullLicense: licenseNo, candidateInputPath: prepared.candidateInputPath, candidateInputSha256: prepared.candidateInputSha256, rawSourcePath: prepared.rawSourcePath, rawSourceSha256: prepared.rawSourceSha256 });
    if (processed % 25 === 0) console.log(JSON.stringify({ processed, eligible: eligible.length, reused, aiCalls: 0, cloudWrites: 0 }));
  }
  const manifestPaths = [];
  for (let i = 0; i < eligible.length; i += 50) {
    const items = eligible.slice(i, i + 50), batchId = "tfda-" + hash(JSON.stringify(items)).slice(0, 24);
    const manifestPath = join(output, "batches", batchId + ".json");
    const manifest = { schema: "tfda-source-publication-batch/v1", batchId, project: "project-b6fe4904-e687-4365-b2f", bucket: "project-b6fe4904-e687-4365-b2f-yzt-test-data", indexSnapshots, items };
    await atomic(manifestPath, manifest); manifestPaths.push(manifestPath);
  }
  const summary = { schema: "tfda-source-preparation-summary/v1", at: new Date().toISOString(), corpus, inventory, products: products.length, assessed: processed, reused, counts, reasons, eligible: eligible.length, manifests: manifestPaths, aiCalls: 0, cloudWrites: 0, humanReviewed: false, clinicalReviewed: false };
  await atomic(join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify({ status: "failed", code: String(error.code || error.message).slice(0, 200) })); process.exitCode = 1; });
}
