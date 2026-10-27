import { createHash } from "node:crypto";
import type { Chunk, Citation } from "../shared/schema.js";
import { SOURCE_PAGE_CHAR_LIMIT } from "../shared/source.js";
import { fail } from "./config.js";

export interface SourceField {
  quote: string;
  citations: Citation[];
  sourceSection?: string;
  originalFieldId?: string;
  originalFieldUnitIndex?: number;
  originalFieldUnitCount?: number;
  evidenceKind?:
    "structural_container" | "literal_unavailable" | "literal_short_field";
  /** Complete canonical text may be read without being selectable by a model. */
  modelEligible?: boolean;
}
export interface PassageSupport {
  chunkId: string;
  quote: string;
  citations?: Citation[];
  sourceSection?: string;
  originalFieldId?: string;
  originalFieldUnitIndex?: number;
  originalFieldUnitCount?: number;
  evidenceKind?:
    "structural_container" | "literal_unavailable" | "literal_short_field";
  modelEligible?: boolean;
}
export const compactSource = (text: string) =>
  text.normalize("NFKC").replace(/\s/gu, "");
export const passageCitations = (passage: PassageSupport): Citation[] =>
  passage.citations || [{ chunkId: passage.chunkId, quote: passage.quote }];
export function sameCitationSet(left: Citation[], right: Citation[]) {
  const key = (citation: Citation) =>
    JSON.stringify([citation.chunkId, compactSource(citation.quote)]);
  const a = left.map(key);
  const b = right.map(key);
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    new Set(b).size === b.length &&
    a.every((value, index) => value === b[index])
  );
}
const invalid = () =>
  fail(
    "source_requires_review",
    "仿單欄位的原始頁面或完整段落無法核對，請先完成來源整理。",
    422,
  );
const complete = (text: string) => {
  // Typography is a classification projection only. Quotes/citations stay exact.
  const projected = text.normalize("NFKC");
  return (
    /[。！？.!?；;][」』”"')）]*\s*$/u.test(projected) &&
    !/(?:^|\n)\s*(?:\d+|[一二三四五六七八九十]+)\s*[.、]\s*$/u.test(projected)
  );
};
function literalUnavailable(text: string, extended = false) {
  if (/^(?:無|N\/?A|尚無資訊|目前尚無資訊)[。.!?；;]?$/iu.test(text))
    return true;
  // Exact whole-field absence markers may have an explicit literature label or
  // balanced quotation marks. Never remove other prose, conditions, or tables.
  const absence = extended
    ? "(?:無|N\\/?A|尚無資訊|目前尚無資訊)[。.!?；;]?"
    : "(?:尚無資訊|目前尚無資訊)[。.!?；;]?";
  const literature = extended
    ? "(?:\\(依文獻記載\\)|【依文獻記載】|《依文獻記載》)"
    : "(?:\\(依文獻記載\\)|【依文獻記載】)";
  const bracketed = extended ? `|【\\s*${absence}\\s*】` : "";
  return new RegExp(
    `^(?:${literature}\\s*)?(?:${absence}|「\\s*${absence}\\s*」|『\\s*${absence}\\s*』|“\\s*${absence}\\s*”|"\\s*${absence}\\s*"${bracketed})[。.!?；;]?$`,
    extended ? "iu" : "u",
  ).test(text);
}
function parentheticalReference(text: string, index: number) {
  // A balanced, explicit cross-reference is part of its containing field, not
  // another heading. Keep every original character; do not repair unmatched
  // parentheses or treat an ordinary bracketed heading as a reference.
  const prefix = text
    .slice(0, index)
    .match(/([（(])\s*(?:請)?(?:參見|參閱|參考|詳見)\s*$/u);
  if (!prefix) return false;
  const suffix = text.slice(index).match(/^【[^【】\r\n]{1,40}】\s*([)）])/u);
  return (
    !!suffix &&
    ((prefix[1] === "(" && suffix[1] === ")") ||
      (prefix[1] === "（" && suffix[1] === "）"))
  );
}
export function withoutParentheticalReferences<
  T extends { index: number; section: string },
>(text: string, marks: T[]): T[] {
  return marks.filter((mark) => !parentheticalReference(text, mark.index));
}
function nestedStructuralHeading(quote: string, body: string, section: string) {
  // The official numbered warning container can contain its synonymous child
  // heading before a separately marked warning. No prose or child body may be
  // dropped, and the child must belong to this exact numbered parent.
  if (section !== "警語及注意事項") return false;
  const parent = quote
    .normalize("NFKC")
    .match(/^\s*(\d+)\s+警語及注意事項\s*\n/u);
  if (!parent) return false;
  const projected = compactSource(body).replace(/^\(依文獻記載\)/u, "");
  return projected === `${parent[1]}.1警語/注意事項`;
}
function numberedUnavailable(quote: string, body: string, section: string) {
  // A numbered tree is unavailable only when every recognized child explicitly
  // says so. Never apply this evidence kind to a field containing medical prose.
  const children =
    section === "副作用/不良反應"
      ? ["臨床重要副作用/不良反應", "臨床試驗經驗", "上市後經驗"]
      : section === "警語及注意事項"
        ? ["警語/注意事項"]
        : undefined;
  if (!children) return false;
  const parent = quote.normalize("NFKC").match(/^\s*(\d+)\s+[^\n]+\n/u);
  if (!parent) return false;
  const projected = body
    .normalize("NFKC")
    .replace(/^(?:\(依文獻記載\)|【依文獻記載】|《依文獻記載》)\s*/u, "");
  const marks = [
    ...projected.matchAll(
      /(?:^|\n)[^\S\r\n]*(\d+)\.(\d+)[^\S\r\n]+([^\r\n]+)\r?\n/gu,
    ),
  ];
  if (!marks.length || marks.length > children.length) return false;
  const prefix = projected.slice(0, marks[0].index).trim();
  if (prefix && !literalUnavailable(prefix, true)) return false;
  return marks.every((mark, index) => {
    const end = marks[index + 1]?.index ?? projected.length;
    return (
      mark[1] === parent[1] &&
      Number(mark[2]) === index + 1 &&
      compactSource(mark[3]) === children[index] &&
      literalUnavailable(
        projected.slice(mark.index! + mark[0].length, end).trim(),
        true,
      )
    );
  });
}
const visibleLength = (text: string) =>
  text.replace(/\s+/gu, " ").trim().length;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Assemble only complete, uniquely ordered canonical pages; never repair text. */
export function canonicalSourceFields(
  chunks: Chunk[],
  headings: (text: string) => { index: number; section: string }[],
  safetySections: ReadonlySet<string>,
): SourceField[] {
  const ids = new Set<string>();
  const documents = new Map<string, Chunk[]>();
  const versions = new Map<string, string>();
  for (const chunk of chunks) {
    if (
      ids.has(chunk.id) ||
      !chunk.text ||
      !Number.isInteger(chunk.page) ||
      chunk.page < 1 ||
      chunk.start !== 0 ||
      (chunk.sourceFormat !== undefined &&
        !["pdf", "html"].includes(chunk.sourceFormat))
    )
      invalid();
    ids.add(chunk.id);
    if (
      versions.has(chunk.licenseNo) &&
      versions.get(chunk.licenseNo) !== chunk.version
    )
      invalid();
    versions.set(chunk.licenseNo, chunk.version);
    const key = JSON.stringify([chunk.licenseNo, chunk.version]);
    documents.set(key, [...(documents.get(key) || []), chunk]);
  }
  const fields: SourceField[] = [];
  for (const pages of documents.values()) {
    pages.sort((a, b) => a.page - b.page);
    if (
      pages.some((page, index) => page.page !== index + 1) ||
      pages.reduce((total, page) => total + page.text.length, 0) >
        SOURCE_PAGE_CHAR_LIMIT ||
      (pages.length > 1 && pages.some((page) => page.sourceFormat !== "pdf"))
    )
      invalid();
    let text = "";
    const spans = pages.map((chunk, index) => {
      if (index) text += "\n";
      const start = text.length;
      text += chunk.text;
      return { chunk, start, end: text.length };
    });
    const marks = withoutParentheticalReferences(text, headings(text));
    const boundaries = [
      ...new Set([0, ...marks.map((mark) => mark.index), text.length]),
    ];
    const citations = (start: number, end: number): Citation[] =>
      spans.flatMap((span) => {
        const left = Math.max(start, span.start);
        const right = Math.min(end, span.end);
        return left < right
          ? [
              {
                chunkId: span.chunk.id,
                quote: span.chunk.text.slice(
                  left - span.start,
                  right - span.start,
                ),
              },
            ]
          : [];
      });
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index],
        end = boundaries[index + 1];
      const sourceSection = marks.find((mark) => mark.index === start)?.section;
      const support = citations(start, end);
      const quote = support.map((citation) => citation.quote).join("\n");
      if (!safetySections.has(sourceSection || "")) {
        // Other fields retain their original per-page citation behavior.
        for (const citation of support)
          fields.push({
            quote: citation.quote,
            citations: [citation],
            sourceSection,
          });
        continue;
      }
      let evidenceKind: SourceField["evidenceKind"];
      const shortLabel = [...sourceSection!]
        .map((char) => char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join("\\s*");
      const shortHeading = new RegExp(
        `^\\s*(?:【\\s*${shortLabel}\\s*】\\s*[:：]?|(?:\\d+\\s+)?${shortLabel}\\s*[:：]?)\\s*`,
        "u",
      );
      const shortBody = quote
        .normalize("NFKC")
        .replace(shortHeading, "")
        .trim();
      if (
        literalUnavailable(shortBody) ||
        (!complete(quote) &&
          (literalUnavailable(shortBody, true) ||
            numberedUnavailable(quote, shortBody, sourceSection!)))
      )
        evidenceKind = "literal_unavailable";
      else if (
        (!shortBody ||
          nestedStructuralHeading(quote, shortBody, sourceSection!)) &&
        safetySections.has(
          marks.find((mark) => mark.index === end)?.section || "",
        )
      )
        evidenceKind = "structural_container";
      // A brief, fully delimited source field can remain literal reading.
      // Keep it out of model evidence: a short source label is not a license
      // to infer its medical meaning, and a lone glyph is still unresolved.
      if (
        !evidenceKind &&
        complete(quote) &&
        compactSource(quote).length < 8 &&
        compactSource(shortBody).replace(/[。！？.!?；;][」』”"')）]*$/u, "")
          .length >= 2
      )
        evidenceKind = "literal_short_field";
      if (
        (!complete(quote) || compactSource(quote).length < 8) &&
        !evidenceKind
      )
        invalid();
      if (evidenceKind && support.length !== 1) invalid();
      const originalFieldId =
        "field-" +
        hash(
          JSON.stringify([
            pages[0].licenseNo,
            pages[0].version,
            sourceSection,
            support,
          ]),
        ).slice(0, 20);
      // Numbered items do not prove independent scope: an earlier item can
      // constrain every later one. Preserve the field and its original spans.
      // The 1500-character limit applies only to model-selectable evidence;
      // backend source_exact_safety text is complete original-source reading.
      if (support.length > 6) invalid();
      fields.push({
        quote,
        citations: support,
        sourceSection,
        originalFieldId,
        originalFieldUnitIndex: 0,
        originalFieldUnitCount: 1,
        modelEligible:
          evidenceKind !== "literal_short_field" &&
          visibleLength(quote) <= 1500,
        ...(evidenceKind ? { evidenceKind } : {}),
      });
    }
  }
  return fields;
}
