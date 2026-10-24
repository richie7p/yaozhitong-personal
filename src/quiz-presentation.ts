import type { GroundedResult } from "../shared/schema";

type Quiz = GroundedResult["quiz"][number];
type PresentationInput = Pick<Quiz,
  "q" | "options" | "explanationKind" | "learningObjective" | "assessmentScope" | "sourceSection"
>;

export interface SharedQuizPresentation {
  question: string;
  contextBefore: string;
  contextAfter: string;
  options: [string, string];
  /** Exact decomposition, independent of the overlapping visible question scope. */
  prefix: string;
  suffix: string;
}

function sentenceEnds(value: string): number[] | undefined {
  const pairs: Record<string, string> = {
    "(": ")", "（": "）", "[": "]", "【": "】", "{": "}",
    "「": "」", "『": "』", "“": "”", "‘": "’",
  };
  const closes = new Set(Object.values(pairs));
  const stack: string[] = [];
  const ends = [0];
  let offset = 0;
  for (const character of value) {
    // A valid non-BMP character stays whole; damaged UTF-16 falls back unchanged.
    if (character.length === 1 && /[\uD800-\uDFFF]/u.test(character)) return undefined;
    if (character === '"') {
      if (stack.at(-1) === character) stack.pop();
      else stack.push(character);
    } else if (pairs[character]) stack.push(pairs[character]);
    else if (closes.has(character)) {
      if (stack.pop() !== character) return undefined;
    }
    offset += character.length;
    if (!stack.length && /[。！？!?]/u.test(character)) ends.push(offset);
  }
  if (stack.length) return undefined;
  return [...new Set([...ends, value.length])];
}

/** A reversible view of one long, already-saved source-reading template.
 * No answer, ID, citation, clinical interpretation or persistence is consulted. */
export function sharedQuizPresentation(q: PresentationInput): SharedQuizPresentation | undefined {
  if (q.explanationKind !== "source_quote" || q.learningObjective !== "warning" ||
    q.assessmentScope !== "one_key_point" || q.options.length !== 2 ||
    q.options.some((option) => option.length < 80)) return undefined;
  const template = q.q.match(/^依仿單「([^」]+)」欄，關於「(.+)」，以下哪項與原文相符？$/u);
  if (!template || template[1] !== q.sourceSection) return undefined;
  const [a, b] = q.options;
  if (a === b) return undefined;
  const aPoints = [...a], bPoints = [...b];
  let front = 0, back = 0;
  while (front < Math.min(aPoints.length, bPoints.length) && aPoints[front] === bPoints[front]) front++;
  while (back < Math.min(aPoints.length, bPoints.length) - front &&
    aPoints[aPoints.length - back - 1] === bPoints[bPoints.length - back - 1]) back++;
  const rawPrefix = aPoints.slice(0, front).join("");
  const rawSuffix = back ? aPoints.slice(-back).join("") : "";
  // Multiple separated edits are not a single comparison region.
  const aChanged = aPoints.slice(front, aPoints.length - back).join("");
  const bChanged = bPoints.slice(front, bPoints.length - back).join("");
  if ([...aChanged].some((character) => bChanged.includes(character))) return undefined;
  const aEnds = sentenceEnds(a), bEnds = sentenceEnds(b);
  if (!aEnds || !bEnds) return undefined;
  const prefixLength = Math.max(...aEnds.filter((end) => end <= rawPrefix.length && bEnds.includes(end)));
  const suffixLength = Math.max(...aEnds.map((end) => a.length - end).filter((length) =>
    length <= rawSuffix.length && bEnds.includes(b.length - length) &&
    a.length - length >= prefixLength && b.length - length >= prefixLength));
  const prefix = a.slice(0, prefixLength);
  const suffix = suffixLength ? a.slice(-suffixLength) : "";
  const options: [string, string] = [a.slice(prefixLength, a.length - suffixLength), b.slice(prefixLength, b.length - suffixLength)];
  if (prefix.length + suffix.length < 60 || options.some((option) => {
    const ends = sentenceEnds(option);
    return option.trim().length < 8 || option.length > 160 || !ends ||
      ends.some((end) => end > 0 && end < option.trimEnd().length);
  })) return undefined;
  if (options.some((option, index) => prefix + option + suffix !== q.options[index])) return undefined;
  // The full quoted scope stays visible, even where it overlaps the beginning
  // of the complete item repeated in each radio. It never becomes a summary.
  const topic = template[2], topicAt = rawPrefix.indexOf(topic);
  if (topicAt < 0) return undefined;
  const contextBefore = rawPrefix.slice(0, Math.max(prefix.length, topicAt + topic.length));
  if (!contextBefore.includes(topic) || !a.startsWith(contextBefore) || !b.startsWith(contextBefore)) return undefined;
  return {
    question: `依仿單「${template[1]}」欄，以下哪項與原文相符？`,
    contextBefore, contextAfter: suffix, options, prefix, suffix,
  };
}
