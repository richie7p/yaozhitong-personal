import type { Chunk, Claim } from "../shared/schema.js";
import {
  passageCitations,
  sameCitationSet,
  type PassageSupport,
} from "./source-field-spans.js";

interface Passage extends PassageSupport {}
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
    `^\\s*(?:\\d+[^\\S\\r\\n]+)?(?:【\\s*${label}\\s*】|${label}\\s*:|${label}[^\\S\\r\\n]*\\r?\\n)\\s*`,
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
  const exact = (passage: Passage) =>
    sameCitationSet(claim.citations, passageCitations(passage));
  const complete = (passage: Passage, citation: Claim["citations"][number]) =>
    passageCitations(passage).length > 1
      ? exact(passage)
      : norm(citation.quote) === norm(passage.quote) ||
        norm(citation.quote) === body(passage);
  return (
    claim.citations.length > 0 &&
    claim.citations.every((citation) => {
      const chunk = chunks.find(
        (candidate) => candidate.id === citation.chunkId,
      );
      if (!chunk) return false;
      const text = norm(chunk.text),
        quote = norm(citation.quote);
      const starts = positions(text, quote);
      if (!quote || !starts.length) return false;
      const candidates = passages.filter((passage) =>
        passageCitations(passage).some(
          (support) => support.chunkId === citation.chunkId,
        ),
      );
      for (const passage of candidates.filter((candidate) =>
        warningSections.has(candidate.sourceSection || ""),
      )) {
        const overlaps = passageCitations(passage)
          .filter((support) => support.chunkId === citation.chunkId)
          .some((support) =>
            positions(text, norm(support.quote)).some((start) =>
              starts.some(
                (quoteStart) =>
                  quoteStart < start + norm(support.quote).length &&
                  quoteStart + quote.length > start,
              ),
            ),
          );
        if (
          overlaps &&
          (passage.modelEligible === false || !complete(passage, citation))
        )
          return false;
      }
      return (
        claim.category !== "warning" ||
        candidates.some((passage) => complete(passage, citation))
      );
    })
  );
}
