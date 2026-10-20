import type { Chunk, Claim } from "../shared/schema.js";

interface Passage {
  chunkId: string;
  quote: string;
  sourceSection?: string;
}
const norm = (text: string) => text.normalize("NFKC").replace(/\s/gu, "");
const positions = (text: string, part: string) => {
  const found: number[] = [];
  if (!part) return found;
  for (
    let start = text.indexOf(part);
    start >= 0;
    start = text.indexOf(part, start + 1)
  )
    found.push(start);
  return found;
};
function body(passage: Passage) {
  if (!passage.sourceSection) return norm(passage.quote);
  const label = [...passage.sourceSection].join("\\s*");
  const heading = new RegExp(
    `^\\s*(?:【\\s*${label}\\s*】|${label}\\s*:|${label}[^\\S\\r\\n]*\\r?\\n)\\s*`,
    "u",
  );
  return norm(passage.quote.normalize("NFKC").replace(heading, ""));
}

/** Direct provider quotes cannot bypass the complete warning-source boundary. */
export function completeWarningCitations(
  claim: Claim,
  chunks: Chunk[],
  passages: Passage[],
  warningSections: ReadonlySet<string>,
) {
  return claim.citations.every((citation) => {
    const chunk = chunks.find((candidate) => candidate.id === citation.chunkId);
    if (!chunk) return false;
    const text = norm(chunk.text),
      quote = norm(citation.quote);
    const starts = positions(text, quote);
    if (!starts.length) return false;
    const candidates = passages.filter(
      (passage) => passage.chunkId === citation.chunkId,
    );
    const complete = (passage: Passage) =>
      quote === norm(passage.quote) || quote === body(passage);
    for (const passage of candidates.filter((p) =>
      warningSections.has(p.sourceSection || ""),
    )) {
      const original = norm(passage.quote);
      const overlaps = positions(text, original).some((start) =>
        starts.some(
          (quotedStart) =>
            quotedStart < start + original.length &&
            start < quotedStart + quote.length,
        ),
      );
      if (overlaps && !complete(passage)) return false;
    }
    // Unlabelled legacy sources still need a complete proposed passage when
    // presented as a warning. Omitting/changing the category cannot bypass
    // the labelled warning boundary checked above.
    return claim.category !== "warning" || candidates.some(complete);
  });
}
