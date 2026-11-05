import { parse, type DefaultTreeAdapterMap } from "parse5";
import { readReferencePdf } from "./reference-pdf.js";
import type { ReferenceSearch } from "../shared/assistance.js";
import type { Drug } from "../shared/schema.js";
import {
  relevantReferenceText,
  referenceFormCompatible,
  canonicalReferenceUrl,
} from "./reference-search.js";

const maxBytes = 1_000_000;
type HtmlNode = DefaultTreeAdapterMap["node"];
const excluded = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "nav",
  "header",
  "footer",
  "form",
]);
const blocks = new Set([
  "p",
  "li",
  "div",
  "section",
  "article",
  "main",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "td",
  "th",
]);

/** Parse text without executing HTML or dropping the surrounding warning/list context. */
export function referenceHtmlText(html: string): string {
  const document = parse(html);
  const findMain = (n: HtmlNode): HtmlNode | undefined => {
    if (
      "tagName" in n &&
      (n.tagName === "main" ||
        n.attrs.some((a) => a.name === "role" && a.value === "main"))
    )
      return n;
    if ("childNodes" in n)
      for (const child of n.childNodes) {
        const main = findMain(child);
        if (main) return main;
      }
  };
  const read = (n: HtmlNode): string => {
    if (n.nodeName === "#text")
      return (n as DefaultTreeAdapterMap["textNode"]).value;
    if (
      "tagName" in n &&
      (excluded.has(n.tagName) ||
        n.attrs.some(
          (a) =>
            a.name === "hidden" ||
            (a.name === "aria-hidden" && a.value === "true"),
        ))
    )
      return "";
    const text = "childNodes" in n ? n.childNodes.map(read).join("") : "";
    return "tagName" in n && blocks.has(n.tagName) ? "\n" + text + "\n" : text;
  };
  return read(findMain(document) || document)
    .replace(/[\t \r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readSource(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    const trusted = canonicalReferenceUrl(url);
    if (!trusted) throw Error("untrusted_reference");
    const response = await fetcher(trusted, {
      redirect: "manual",
      signal,
      headers: {
        accept: "text/html, application/pdf;q=0.9, text/plain;q=0.8",
        "user-agent": "YaoZhiTong-ReferenceReader/1.0",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const target = response.headers.get("location");
      if (!target) throw Error("missing_redirect");
      url = new URL(target, trusted).href;
      continue;
    }
    const type = response.headers.get("content-type") || "";
    if (
      !response.ok ||
      !/^(?:text\/html|text\/plain|application\/xhtml\+xml|application\/pdf)\b/i.test(type) ||
      Number(response.headers.get("content-length")) > maxBytes
    ) {
      await response.body?.cancel();
      throw Error("unreadable_reference");
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("empty_reference");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) throw Error("oversized_reference");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytesRead = Buffer.concat(chunks);
    if (/^application\/pdf\b/i.test(type))
      return { url: trusted, text: await readReferencePdf(bytesRead, signal) };
    const charset =
      type.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || "utf-8";
    const raw = new TextDecoder(charset).decode(bytesRead);
    return {
      url: trusted,
      text: /text\/plain/i.test(type) ? raw.trim() : referenceHtmlText(raw),
    };
  }
  throw Error("too_many_redirects");
}

/** Search summaries locate sources; only fetched original text becomes evidence. */
export async function readReferenceContent(
  search: ReferenceSearch,
  drugs: Drug[],
  options: { fetcher?: typeof fetch; signal?: AbortSignal; onRead?: (outcome: string) => void } = {},
): Promise<ReferenceSearch> {
  if (search.state !== "found")
    return { state: search.state, sources: [], passages: [] };
  const signal = options.signal || AbortSignal.timeout(10000);
  let readable = 0;
  const sources: ReferenceSearch["sources"] = [];
  for (const source of search.sources) {
    const url = canonicalReferenceUrl(source.url);
    if (url && !sources.some((s) => s.url === url)) sources.push({ ...source, url });
    if (sources.length === 12) break;
  }
  const read = async (source: ReferenceSearch["sources"][number]) => {
    try {
      const page = await readSource(
        source.url,
        signal,
        options.fetcher || fetch,
      );
      // Omit an oversized document in full, never truncate a warning mid-condition.
      if (page.text.length < 100 || page.text.length > 24000) {
        options.onRead?.("text_size");
        return null;
      }
      readable++;
      const heading = page.text.split("\n").find((line) => line.trim()) || "";
      if (
        !drugs.some(
          (drug) =>
            relevantReferenceText(page.text, [drug]) &&
            referenceFormCompatible(heading, drug),
        )
      ) {
        options.onRead?.("name_or_form_mismatch");
        return null;
      }
      options.onRead?.("accepted");
      return { source: { ...source, url: page.url }, text: page.text };
    } catch (error) {
      const code = error instanceof Error ? error.message : "read_failed";
      options.onRead?.(signal.aborted ? "deadline" : [
        "unreadable_reference", "empty_reference", "oversized_reference",
        "unreadable_reference_pdf", "untrusted_reference", "too_many_redirects",
      ].includes(code) ? code : "read_failed");
      return null;
    }
  };
  const reads: Awaited<ReturnType<typeof read>>[] = new Array(sources.length);
  let next = 0;
  // Start at most six reads. Each freed slot can reach a later candidate while
  // a slow earlier source is pending. A name-matching inventory or combination
  // product is not necessarily useful education: read the bounded candidate
  // set rather than stopping after two such pages. The outer deadline and
  // twelve-document cap still apply to the whole attempt.
  const worker = async () => {
    while (next < sources.length && !signal.aborted) {
      const index = next++;
      const row = await read(sources[index]);
      reads[index] = row;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, sources.length) }, worker));
  const result: ReferenceSearch = {
    state: readable ? "not_found" : "unavailable",
    sources: [],
    passages: [],
  };
  let remaining = 60000;
  // Prefer originals containing several patient-information topics over long
  // inventories before applying the shared context cap. This is selection,
  // not clinical approval; generation and source review still check every claim.
  const topicCount = (text: string) => [
    /適應症|藥品作用|藥物作用|用途|indications|used to treat/i,
    /注意事項|使用注意|警語|警告|precautions|warnings/i,
    /副作用|不良反應|side effects|adverse reactions/i,
    /保存|貯存|儲存|storage|store (?:at|below|in)/i,
  ].filter((topic) => topic.test(text)).length;
  for (const row of reads.filter((row) => !!row).sort((a, b) => topicCount(b.text) - topicCount(a.text))) {
    if (
      !row ||
      row.text.length > remaining ||
      result.sources.some((s) => s.url === row.source.url)
    )
      continue;
    result.sources.push(row.source);
    result.passages.push({ text: row.text, sourceIds: [row.source.id] });
    remaining -= row.text.length;
  }
  if (result.passages.length) result.state = "found";
  return result;
}
