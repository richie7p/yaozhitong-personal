import type { Chunk, Claim, GroundedResult } from "../shared/schema.js";
import { SAFETY_SECTIONS } from "./safety-learning.js";
import {
  compactSource,
  passageCitations,
  sameCitationSet,
  type PassageSupport,
} from "./source-field-spans.js";

type Topic = {
  name: string;
  requested: RegExp;
  matches: (field: PassageSupport) => boolean;
};
const topics: Topic[] = [
  {
    name: "禁用情形",
    requested:
      /禁忌|禁用|禁服|(?:不能|不可以|不宜)(?:使用|服用|用)|(?:請勿|不得|不可)(?:使用|服用)|contraindication/iu,
    matches: (field) =>
      /禁忌/.test(field.sourceSection || "") ||
      /禁忌|禁用|禁服|禁止(?:使用|服用)|(?:切勿|請勿|勿|不得|不可|不宜)(?:使用|服用|投用|用於|用)/u.test(
        compactSource(field.quote),
      ),
  },
  {
    name: "交互作用",
    requested:
      /交互作用|交互影響|藥物相互作用|(?:併用|合併使用|同時服用).*(?:藥|影響)|interaction/iu,
    matches: (field) =>
      field.sourceSection === "交互作用" ||
      /交互作用/u.test(compactSource(field.quote)),
  },
  {
    name: "過量",
    requested: /過量|超量|過度服用|overdos/iu,
    matches: (field) =>
      field.sourceSection === "過量" ||
      /過量|超量|過度服用/u.test(compactSource(field.quote)),
  },
  {
    name: "副作用／不良反應",
    requested: /副作用|不良反應|身體部位|adverse|sideeffect/iu,
    matches: (field) =>
      /副作用|不良反應/u.test(field.sourceSection || "") ||
      /副作用|不良反應/u.test(compactSource(field.quote)),
  },
  {
    name: "警語",
    requested: /警語|警告|warnings?/iu,
    matches: (field) => /警語|注意事項/u.test(field.sourceSection || ""),
  },
  {
    name: "注意事項",
    requested: /注意事項|注意什麼|注意哪些|precautions?/iu,
    matches: (field) => /警語|注意事項/u.test(field.sourceSection || ""),
  },
];

function completeFieldText(field: PassageSupport, claim: Claim) {
  if (!sameCitationSet(claim.citations, passageCitations(field))) return false;
  const text = compactSource(claim.text),
    original = field.quote.trim();
  if (text === compactSource(original)) return true;
  // A recognized standalone heading line may be omitted from the explanation.
  // Conditions or numbered items on the next line are never removed.
  const end = original.indexOf("\n");
  if (end < 0) return false;
  const heading = compactSource(original.slice(0, end))
    .replace(/^\d+(?:\.\d+)*[.、]?/u, "")
    .replace(/[【】:：]/gu, "");
  return (
    heading === compactSource(field.sourceSection || "") &&
    text === compactSource(original.slice(end + 1))
  );
}

/** Coverage is proved per actual canonical field and publication, after review.
 * A full citation attached to a one-point summary does not prove a full answer.
 * Unassessed source text is retained separately and never becomes an AI claim. */
export function completeRequestedChatCoverage(
  question: string,
  chunks: Chunk[],
  selected: Chunk[],
  passages: (PassageSupport & { licenseNo: string })[],
  claims: Claim[],
  existing?: GroundedResult["sourceReading"],
): { incomplete: boolean; sourceReading?: GroundedResult["sourceReading"] } {
  // Remove only an adjacent named safety topic or a list of those names.
  // Negating an unrelated object cannot cancel a later positive safety request.
  // Ambiguous wording remains conservative instead of discarding a clause tail.
  const excludedTopic =
    "(?:禁忌(?:症)?|禁用(?:情形)?|禁服|交互作用|交互影響|藥物相互作用|過量(?:資訊)?|超量|副作用|不良反應|警語|警告|注意事項|contraindications?|interactions?|overdose|adversereactions?|sideeffects?|warnings?|precautions?)";
  const exclusion = new RegExp(
    `(?:不需要|不需|無需|不必|不用|不要)(?:再)?(?:說明|回答|列出|提供|解釋|介紹|給我)?(?:有關|關於)?${excludedTopic}(?:(?:或|和|及|以及|、|/|與)${excludedTopic})*(?!以外|之外|除外)(?=$|[，,。；;！？!?]|但|不過|另外|只|僅|請|再)`,
    "giu",
  );
  const requestedQuestion = compactSource(question).replace(exclusion, "");
  const requested = topics.filter((topic) =>
    topic.requested.test(requestedQuestion),
  );
  if (!requested.length) {
    const explicitPurposeOnly =
      /[只僅].{0,8}(?:用途|適應症|效能)/u.test(requestedQuestion) &&
      !/(?:不需要|不需|無需|不必|不用|不要).{0,4}[只僅]/u.test(
        requestedQuestion,
      );
    const unrelatedSafetyOnly =
      !existing ||
      (existing.reason === "model_source_capacity" &&
        existing.sections.every((section) =>
          SAFETY_SECTIONS.has(section.sourceSection),
        ) &&
        (existing.unavailableSections || []).every((section) =>
          SAFETY_SECTIONS.has(section.sourceSection),
        ));
    // An explicit purpose-only question does not ask the AI to assess unrelated
    // safety fields. The independent purpose completeness guard still applies.
    if (explicitPurposeOnly && unrelatedSafetyOnly)
      return { incomplete: false };
    return { incomplete: !!existing, sourceReading: existing };
  }
  const documents = [
    ...new Map(chunks.map((chunk) => [chunk.licenseNo, chunk])).values(),
  ];
  const missing = new Map<string, (typeof passages)[number]>();
  const missingTopics: NonNullable<
    GroundedResult["sourceReading"]
  >["missingTopics"] = [];
  for (const document of documents) {
    const fields = passages.filter(
      (field) =>
        field.licenseNo === document.licenseNo &&
        SAFETY_SECTIONS.has(field.sourceSection || "") &&
        field.evidenceKind !== "structural_container",
    );
    for (const topic of requested) {
      const matching = fields.filter(topic.matches);
      if (!matching.length)
        missingTopics.push({
          topic: topic.name,
          licenseNo: document.licenseNo,
          version: document.version,
        });
      for (const field of matching)
        if (!claims.some((claim) => completeFieldText(field, claim)))
          missing.set(JSON.stringify(passageCitations(field)), field);
    }
  }
  if (!missing.size && !missingTopics.length)
    return { incomplete: !!existing, sourceReading: existing };
  const sections = [...(existing?.sections || [])];
  const unavailableSections = [...(existing?.unavailableSections || [])];
  const selectedIds = new Set(selected.map((chunk) => chunk.id));
  let eligibleFieldUnanswered = false;
  for (const field of missing.values()) {
    const citations = passageCitations(field);
    if (
      citations.length <= 6 &&
      citations.every((citation) => selectedIds.has(citation.chunkId))
    ) {
      if (
        !sections.some((section) =>
          sameCitationSet(section.citations, citations),
        )
      )
        sections.push({ sourceSection: field.sourceSection!, citations });
      if (field.modelEligible !== false) eligibleFieldUnanswered = true;
    } else {
      const document = documents.find(
        (chunk) => chunk.licenseNo === field.licenseNo,
      )!;
      if (
        !unavailableSections.some(
          (section) =>
            section.licenseNo === document.licenseNo &&
            section.version === document.version &&
            section.sourceSection === field.sourceSection,
        )
      )
        unavailableSections.push({
          sourceSection: field.sourceSection!,
          licenseNo: document.licenseNo,
          version: document.version,
        });
    }
  }
  sections.sort((left, right) => {
    const rank = (section: (typeof sections)[number]) =>
      passages.findIndex((field) =>
        sameCitationSet(section.citations, passageCitations(field)),
      );
    return rank(left) - rank(right);
  });
  return {
    incomplete: true,
    sourceReading: {
      reason:
        eligibleFieldUnanswered || missingTopics.length
          ? "requested_topic_coverage"
          : existing?.reason || "model_source_capacity",
      sections,
      ...(unavailableSections.length ? { unavailableSections } : {}),
      ...(missingTopics.length ? { missingTopics } : {}),
      ...(existing?.sources ? { sources: existing.sources } : {}),
    },
  };
}
