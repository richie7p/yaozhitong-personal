import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  reliableReferenceUrl,
  type ReferenceSearch,
} from "../shared/assistance.js";
import type { Drug } from "../shared/schema.js";
import {
  relevantReferenceText,
  referenceFormCompatible,
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
    const trusted = reliableReferenceUrl(url);
    if (!trusted) throw Error("untrusted_reference");
    const response = await fetcher(trusted, {
      redirect: "manual",
      signal,
      headers: {
        accept: "text/html, text/plain;q=0.9",
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
      !/^(?:text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(type) ||
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
    const charset =
      type.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || "utf-8";
    const raw = new TextDecoder(charset).decode(Buffer.concat(chunks));
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
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ReferenceSearch> {
  if (search.state !== "found")
    return { state: search.state, sources: [], passages: [] };
  const signal = options.signal || AbortSignal.timeout(10000);
  let readable = 0;
  const reads = await Promise.all(
    search.sources.slice(0, 6).map(async (source) => {
      try {
        const page = await readSource(
          source.url,
          signal,
          options.fetcher || fetch,
        );
        // Omit an oversized document in full, never truncate a warning mid-condition.
        if (page.text.length < 100 || page.text.length > 24000) return null;
        readable++;
        const heading = page.text.split("\n").find((line) => line.trim()) || "";
        if (
          !drugs.some(
            (drug) =>
              relevantReferenceText(page.text, [drug]) &&
              referenceFormCompatible(heading, drug),
          )
        )
          return null;
        return { source: { ...source, url: page.url }, text: page.text };
      } catch {
        return null;
      }
    }),
  );
  const result: ReferenceSearch = {
    state: readable ? "not_found" : "unavailable",
    sources: [],
    passages: [],
  };
  let remaining = 60000;
  for (const row of reads) {
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
