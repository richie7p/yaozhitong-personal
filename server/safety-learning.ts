import { createHash } from "node:crypto";
import type { Claim, GroundedResult } from "../shared/schema.js";
import {
  passageCitations,
  sameCitationSet,
  type PassageSupport,
} from "./source-field-spans.js";

export const SAFETY_SECTIONS = new Set([
  "警語",
  "警語及注意事項",
  "注意事項",
  "使用上注意事項",
  "副作用",
  "副作用/不良反應",
  "附記",
  "禁忌",
  "禁忌症",
  "過量",
  "交互作用",
]);

interface SafetyPassage extends PassageSupport {}
const norm = (text: string) => text.normalize("NFKC").replace(/\s/gu, "");
const sameCitation = (
  claim: { citations: Claim["citations"] },
  p: SafetyPassage,
) => sameCitationSet(claim.citations, passageCitations(p));
const stableId = (p: SafetyPassage) =>
  "safety-" +
  createHash("sha256")
    .update(
      p.chunkId +
        "\n" +
        (p.sourceSection || "") +
        "\n" +
        norm(p.quote) +
        (passageCitations(p).length > 1
          ? "\n" + JSON.stringify(passageCitations(p))
          : ""),
    )
    .digest("hex")
    .slice(0, 16);

function sameSupport(
  left: { citations: Claim["citations"] },
  right: { citations: Claim["citations"] },
) {
  return (
    left.citations.length === right.citations.length &&
    left.citations.every((citation) =>
      right.citations.some(
        (other) =>
          citation.chunkId === other.chunkId &&
          norm(citation.quote) === norm(other.quote),
      ),
    )
  );
}

/** A short whole indication field is safer than dropping a later restriction. */
function purposeReadingQuestion(passage: SafetyPassage) {
  const label = [...passage.sourceSection!]
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const heading = new RegExp(
    `^\\s*(?:\\d+[^\\S\\r\\n]+)?(?:【\\s*${label}\\s*】|${label}\\s*[:：]|${label}[^\\S\\r\\n]*\\r?\\n)\\s*`,
    "u",
  );
  const original = passage.quote.normalize("NFKC");
  if (!heading.test(original)) return undefined;
  const body = original.replace(heading, "").replace(/\s+/gu, " ").trim();
  if (!body || body.length > 360 || !/[。！？.!?）)]$/u.test(body))
    return undefined;
  const id = stableId(passage).replace(/^safety-/u, "purpose-");
  const answer = parseInt(id.slice(-1), 16) % 2;
  const opposite = "原文明確未記載以下用途：" + body;
  return {
    id,
    q: `依仿單「${passage.sourceSection}」欄，哪項符合原文記載的用途及條件？`,
    options: answer === 0 ? [body, opposite] : [opposite, body],
    answer,
    explain: `依仿單「${passage.sourceSection}」原文：${passage.quote.trim()}`,
    explanationKind: "source_quote" as const,
    citations: passageCitations(passage),
    learningObjective: "purpose" as const,
    sourceSection: passage.sourceSection,
    assessmentScope: "one_key_point" as const,
  };
}

/**
 * Call only with actual clinical-purpose fields identified by the source parser.
 * This reproduces source bytes, never repairs a glyph or infers an indication.
 * Independently approved purpose text stays unchanged even when its question
 * is rejected. The complete original field and reading question are separate
 * fallbacks; a question's heading/option failure cannot invalidate safe text.
 */
export function completePurposeLearning(
  result: Pick<GroundedResult, "claims" | "quiz">,
  passages: SafetyPassage[],
) {
  let claims = [...result.claims];
  let quiz = [...result.quiz];
  let complete = passages.length > 0;
  for (const passage of passages) {
    const belongs = (claim: { citations: Claim["citations"] }) =>
      claim.citations.length > 0 &&
      claim.citations.every(
        (citation) =>
          citation.chunkId === passage.chunkId &&
          (norm(passage.quote).includes(norm(citation.quote)) ||
            norm(citation.quote).includes(norm(passage.quote))),
      );
    const purposes = claims.filter(
      (claim) => claim.category === "purpose" && belongs(claim),
    );
    if (
      purposes.some((claim) =>
        quiz.some(
          (question) =>
            question.learningObjective === "purpose" &&
            sameSupport(question, claim),
        ),
      )
    )
      continue;
    // A review of a shortened citation cannot establish later restrictions in
    // this whole purpose field. Preserve only approved text whose own support
    // includes this complete field; otherwise retain the exact-source fallback.
    const fullyScoped = purposes.filter((claim) =>
      sameSupport(claim, { citations: passageCitations(passage) }),
    );
    claims = claims.filter(
      (claim) => !purposes.includes(claim) || fullyScoped.includes(claim),
    );
    if (!fullyScoped.length)
      claims.push({
        text: passage.quote.trim(),
        category: "purpose",
        kind: "source_exact_purpose",
        citations: passageCitations(passage),
      });
    const fallback = purposeReadingQuestion(passage);
    if (fallback) quiz.push(fallback);
    else complete = false;
  }
  return { claims, quiz, complete };
}

/**
 * Use only a complete, bounded field. Sentence punctuation and item numbers
 * do not prove that later parent conditions or exceptions are independent.
 * A longer field remains fully readable without a template assessment.
 */
function completeSafetyUnit(passage: SafetyPassage) {
  if (passage.modelEligible === false) return undefined;
  const name = [...passage.sourceSection!].join("\\s*");
  const heading = new RegExp(
    `^\\s*(?:\\d+[^\\S\\r\\n]+)?(?:【\\s*${name}\\s*】|${name}\\s*[:：]|${name}[^\\S\\r\\n]*\\r?\\n)\\s*`,
    "u",
  );
  let body = passage.quote.normalize("NFKC").replace(heading, "");
  // Only a known standalone subsection heading proves these TAB-separated
  // numbers are outline labels. A decimal dose or condition remains content.
  const subsection =
    passage.sourceSection === "副作用/不良反應"
      ? body.match(/^\s*(\d+\.\d+)\t臨床重要副作用\/不良反應[^\S\r\n]*\r?\n/u)
      : null;
  if (subsection) {
    body = body.slice(subsection[0].length);
    const parent = subsection[1].replace(/\./gu, "\\.");
    body = body.replace(new RegExp(`^\\s*${parent}\\.\\d+\\t(?=\\S)`, "u"), "");
  }
  if (!/[。！？.!?；;][」』”"')）]*\s*$/u.test(body)) return undefined;
  const visible = body
    .replace(
      /^\s*(?:\(\s*\d+\s*\)|\d+[.、](?!\d)|[一二三四五六七八九十]+、)\s*/u,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return (visible.length >= 8 || norm(visible) === "目前尚無資訊。") &&
    visible.length <= 360
    ? visible
    : undefined;
}

/**
 * A local, explicit opposite of a recorded statement supplies the distractor.
 * No drug facts, missing-information assumptions or personal advice are added.
 * Each template tests one source point; it does not certify all subordinate items.
 */
export function safetyReadingQuestion(passage: SafetyPassage) {
  const unit = completeSafetyUnit(passage);
  if (!unit) return undefined;
  // A modal nested inside uncertainty is not a proposition with an explicit
  // opposite (e.g. "possible adverse effects are unknown"). Keep it untested.
  if (/尚(?:不明|未)|不明確|不確定|未確立|是否|有待|不詳|未知/u.test(unit))
    return undefined;
  const opposites: [RegExp, string][] = [
    [/應停藥並就醫/u, "不必停藥或就醫"],
    [/應立即停藥並就醫/u, "不必停藥或就醫"],
    [/應立即停止使用/u, "不必停止使用"],
    [/請立即停止使用/u, "不必停止使用"],
    [/應停止使用/u, "不必停止使用"],
    [/使用前請先諮詢/u, "使用前不必諮詢"],
    [/使用前請洽醫師診治/u, "使用前不必洽醫師診治"],
    [/請勿自行使用/u, "可以自行使用"],
    [/不建議自行使用/u, "建議自行使用"],
    [/不宜使用/u, "可以使用"],
    [/不得使用/u, "可以使用"],
    [/請勿使用/u, "可以使用"],
    [/不可使用/u, "可以使用"],
    [/禁用/u, "可以使用"],
    [/不得併服/u, "可以併服"],
    [/請洽醫師診治/u, "不必洽醫師診治"],
    [/應洽醫師/u, "不必洽醫師"],
    [/請妥善保管/u, "不必妥善保管"],
    [/請告知醫療人員/u, "不必告知醫療人員"],
    [/可能包括/u, "不會包括"],
    [/可能發生/u, "不會發生"],
    [/可能引起/u, "不會引起"],
    [/偶會引起/u, "不會引起"],
  ];
  let incorrect: string | undefined;
  let topic: string | undefined;
  for (const [pattern, replacement] of opposites)
    if (pattern.test(unit)) {
      incorrect = unit.replace(pattern, replacement);
      const match = unit.match(pattern)!;
      const before = unit.slice(0, match.index).replace(/[，,:：\s]+$/u, "");
      const colon = unit.search(/[:：]/u);
      topic =
        /有下列情形者/u.test(before) && colon >= 0
          ? unit.slice(colon + 1).replace(/^\s*\d+[.、]\s*/u, "")
          : before || match[0];
      break;
    }
  if (
    !incorrect &&
    ["副作用", "副作用/不良反應"].includes(passage.sourceSection || "")
  ) {
    incorrect = "本欄明確表示不會發生以下副作用：" + unit;
    topic = "原文列出的副作用";
  }
  if (!incorrect && ["禁忌", "禁忌症"].includes(passage.sourceSection || "")) {
    incorrect = "本欄明確排除以下情形，不列為禁忌：" + unit;
    topic = "原文明列的禁忌情形";
  }
  const unknown = norm(unit) === "目前尚無資訊。";
  if (!incorrect && unknown) {
    incorrect = "目前已有完整資訊。";
    topic = "原文提供的資料狀況";
  }
  // Source attribution or acknowledging unavailable information is reading,
  // not safety comprehension. Leave that field unassessed instead of filling
  // the safety count with a question about whether this text was printed.
  if (!incorrect || unknown) return undefined;
  const id = stableId(passage);
  const answer = parseInt(id.slice(-1), 16) % 2;
  const options = answer === 0 ? [unit, incorrect] : [incorrect, unit];
  return {
    id,
    q: `依仿單「${passage.sourceSection}」欄，關於「${topic}」，以下哪項與原文相符？`,
    options,
    answer,
    explain: `依仿單「${passage.sourceSection}」原文：${passage.quote.trim()}`,
    explanationKind: "source_quote" as const,
    citations: passageCitations(passage),
    learningObjective: "warning" as const,
    sourceSection: passage.sourceSection,
    coverageSectionId: id,
    assessmentScope: "one_key_point" as const,
  };
}

/**
 * Complete recognized safety fields using exact canonical source text. This is
 * only called after a bundle has independently approved clinical-purpose text.
 * Model-reviewed concrete questions take precedence; a bounded source-reading
 * template fills a missing field only when a direct opposite can be established.
 */
export function completeSafetyLearning(
  result: Pick<GroundedResult, "claims" | "quiz">,
  passages: SafetyPassage[],
): Pick<GroundedResult, "claims" | "quiz" | "safetyCoverage"> {
  const safety = passages.filter(
    (p) =>
      SAFETY_SECTIONS.has(p.sourceSection || "") &&
      p.evidenceKind !== "structural_container",
  );
  const claims = result.claims.filter(
    (claim) =>
      claim.category !== "warning" ||
      !safety.some((p) => sameCitation(claim, p)),
  );
  const quiz = [...result.quiz];
  const groups = new Map<
    string,
    NonNullable<GroundedResult["safetyCoverage"]>["sections"][number]
  >();
  const groupId = (passage: SafetyPassage) =>
    passage.originalFieldId || stableId(passage);
  const alreadyReviewed = new Set(
    safety
      .filter((passage) =>
        quiz.some(
          (question) =>
            question.learningObjective === "warning" &&
            sameCitation(question, passage),
        ),
      )
      .map(groupId),
  );
  for (const passage of safety) {
    const id = groupId(passage);
    const reviewed = result.claims.find(
      (claim) => claim.category === "warning" && sameCitation(claim, passage),
    );
    const claimIndex = claims.length;
    claims.push({
      text: passage.quote.trim(),
      category: "warning",
      kind: "source_exact_safety",
      citations: passageCitations(passage),
      ...(reviewed?.profileRefs?.length
        ? { profileRefs: reviewed.profileRefs }
        : {}),
      ...(reviewed?.sourceMentions?.length
        ? { sourceMentions: reviewed.sourceMentions }
        : {}),
    });
    const reviewedQuiz = quiz.filter(
      (question) =>
        question.learningObjective === "warning" &&
        sameCitation(question, passage),
    );
    for (const question of reviewedQuiz) {
      question.coverageSectionId = id;
      question.assessmentScope = "one_key_point";
    }
    const fallback =
      alreadyReviewed.has(id) || groups.get(id)?.quizIds.length
        ? undefined
        : safetyReadingQuestion(passage);
    if (fallback) {
      fallback.coverageSectionId = id;
      quiz.push(fallback);
    }
    const group = groups.get(id) || {
      id,
      chunkId: passage.chunkId,
      sourceSection: passage.sourceSection!,
      claimIndex,
      claimIndices: [],
      quizIds: [],
    };
    group.claimIndices!.push(claimIndex);
    group.quizIds.push(
      ...(reviewedQuiz.length
        ? reviewedQuiz.map((question) => question.id)
        : fallback
          ? [fallback.id]
          : []),
    );
    groups.set(id, group);
  }
  const sections = [...groups.values()];
  const covered = sections.filter((section) => {
    const expected = safety.filter(
      (passage) =>
        (passage.originalFieldId || stableId(passage)) === section.id,
    );
    return (
      expected.length ===
        (expected[0].originalFieldUnitCount ?? expected.length) &&
      (!expected[0].originalFieldUnitCount ||
        expected.every(
          (passage, index) => passage.originalFieldUnitIndex === index,
        )) &&
      expected.length === section.claimIndices!.length &&
      expected.every((passage) =>
        section.claimIndices!.some((index) =>
          sameCitation(claims[index], passage),
        ),
      )
    );
  }).length;
  const tested = sections.filter((section) => section.quizIds.length).length;
  return {
    claims,
    quiz,
    safetyCoverage: {
      scope: "recognized_source_sections",
      assessmentScope: "one_key_point_per_section",
      status: !sections.length
        ? "no_sections"
        : tested === sections.length && covered === sections.length
          ? "complete"
          : "partial",
      sourceSectionCount: sections.length,
      coveredSectionCount: covered,
      quizCoveredSectionCount: tested,
      sections,
    },
  };
}
