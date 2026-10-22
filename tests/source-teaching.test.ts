import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grounded, OutputSchema, sourcePassages, type Llm } from "../server/ai";
import {
  SAFETY_SECTIONS,
  safetyReadingQuestion,
} from "../server/safety-learning";
import {
  completeRequestedChatCoverage,
  requestedSafetyFields,
} from "../server/chat-source-coverage";
import { passageCitations } from "../server/source-field-spans";
import {
  MAX_TEACHING_FIELDS,
  MAX_TEACHING_SOURCE_CHARS,
  FieldTeachingDraftSchema,
  prepareTeachingPlan,
  reviewTeachingPlan,
  sourceCoverageLedger,
  sourceScopeAnchors,
  sourceAbsenceExplicit,
  sourceSituationExplicit,
  sourceConditionBoundariesPreserved,
  sourceInheritedRestrictions,
  sourceInheritedScopePreserved,
  sourceQuizInterpretationExplicit,
  teachingPlanInput,
  teachingScopeLiterals,
  type TeachingField,
} from "../server/source-teaching";
import { AppError } from "../server/config";
import type { Chunk } from "../shared/schema";

const source =
  "【警語】\n除非有醫師指示，以下事項只適用於未滿12歲者。若出現合成皮疹，應停止使用並就醫。不可與合成甲藥併用，以免合成反應加重。";
const plain =
  "以下提醒限定未滿12歲的人，除非有醫師指示。若出現合成皮疹，原文要求停止使用並就醫；也不可以合併合成甲藥，因為合成反應可能變得更嚴重。";
const page = (text: string, id = "SYNTHETIC-TEACHING"): Chunk => ({
  id,
  licenseNo: id,
  version: "synthetic-v1",
  page: 1,
  start: 0,
  sourceFormat: "html",
  text,
});
const field = (text = source, id?: string) =>
  sourcePassages([page(text, id)])[0];
function draftFor(
  item: ReturnType<typeof teachingPlanInput>[number],
  text = plain,
) {
  return {
    fieldId: item.fieldId,
    status: "supported" as const,
    lessons: [{ text, spanIds: item.coverageLedger.map((range) => range.id) }],
    quiz: [
      {
        q: "依仿單警語欄，在未滿12歲且沒有醫師另行指示的情境，若出現合成皮疹，原文記載哪一項處理？",
        options: ["停止使用並就醫", "繼續使用，不必就醫"],
        answer: 0,
        lessonIndices: [0],
        spanIds: item.coverageLedger.map((range) => range.id),
      },
    ],
  };
}
const approve: Llm = {
  json: async (_system, input: any) => ({
    verdicts: input.expectedIds.map((id: string) => ({ id, supported: true })),
  }),
};
const frozen: { licenseNo: string; chunks: Chunk[] }[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/cross-page-source-fields.json", import.meta.url),
    "utf8",
  ),
);

describe("whole-field plain-language teaching with aligned omission ledger", () => {
  it.each([
    ["一般提醒：未記載不能判斷安全。", "【警語】未記載不能判斷安全。", true],
    ["沒有記載就能判斷安全嗎？。不可。", "【警語】未記載不能判斷安全。", true],
    [
      "一般提醒：未記載不能判斷安全。整份仿單未提供劑量。",
      "【警語】未記載不能判斷安全。",
      false,
    ],
    [
      "沒有記載劑量就能判斷安全嗎？。不可。",
      "【警語】未記載不能判斷安全。",
      false,
    ],
    [
      "沒有記載就能判斷安全嗎？。原文沒有劑量資訊。",
      "【警語】未記載不能判斷安全。",
      false,
    ],
    ["一般提醒：未記載不能判斷安全。", "【警語】請勿自行加量。", false],
    ["沒有記載就能判斷安全嗎？。不可。", "【警語】請勿超過建議使用量。", false],
    ["原文沒有劑量，所以無法判斷安全。", "【警語】未記載不能判斷安全。", false],
    ["沒有記載劑量，不能判斷安全。", "【警語】未記載不能判斷安全。", false],
    [
      "原文沒有劑量。未記載不能判斷安全。",
      "【警語】未記載不能判斷安全。",
      false,
    ],
    [
      "未記載不能判斷安全。本欄安全性尚未確立。",
      "【警語】孕婦安全性尚未確立；未記載不能判斷安全。",
      false,
    ],
    [
      "沒有記載就能判斷安全嗎？。不可。",
      "【警語】劑量未記載不能判斷安全。",
      false,
    ],
    ["本欄尚無劑量資訊。", "孕婦安全性尚未建立。成人劑量每次一錠。", false],
    ["本欄安全性尚未確立。", "孕婦安全性尚未確立。", false],
    ["本欄孕婦安全性尚未確立。", "孕婦安全性尚未確立。", true],
    [
      "本欄孕婦安全性尚未確立，因此成人劑量尚無資訊。",
      "孕婦安全性尚未確立。成人劑量每次一錠。",
      false,
    ],
    [
      "原文未提供本藥的具體建議劑量。",
      "【使用上注意事項】勿超過建議使用量。",
      false,
    ],
    ["本欄未記載具體劑量。", "【使用上注意事項】勿超過建議使用量。", false],
    ["這份仿單沒有用法資訊。", "【警語】請勿使用。", false],
    ["本藥沒有任何風險。", "【警語】目前尚無資訊。", false],
    ["本欄沒有風險。", "【警語】風險資訊尚未建立。", false],
    ["本欄明載目前尚無資訊。", "【交互作用】目前尚無資訊。", true],
    ["本欄安全性資料尚未確立。", "【警語】安全性資料尚未確立。", true],
    ["全仿單安全性資料尚未確立。", "【警語】安全性資料尚未確立。", false],
    [
      "本欄目前尚無資訊，這不代表沒有風險。",
      "【交互作用】目前尚無資訊。",
      true,
    ],
    ["即使沒有不適也應立即就醫。", "【警語】即使沒有不適也應立即就醫。", true],
    [
      "本欄目前尚無資訊。整份仿單未提供劑量。",
      "【交互作用】目前尚無資訊。",
      false,
    ],
  ])(
    "bounds informational absence to explicit evidence: %s",
    (text, quote, expected) => {
      expect(sourceAbsenceExplicit(text as string, [quote as string])).toBe(
        expected,
      );
    },
  );

  it("records source-native inherited restriction offsets and checks each child lesson independently", () => {
    const text =
      "【警語】\n一、產婦請先諮詢醫師。\n二、12至18歲，並有下列情形的人：合成甲病。合成乙症。多重創傷或近期大範圍外科手術。吸菸所引起之持續或慢性咳嗽的人。\n三、藥品請妥善保存。";
    const restrictions = sourceInheritedRestrictions(text);
    expect(restrictions).toHaveLength(1);
    const restriction = restrictions[0];
    expect(restriction.kind).toBe("age");
    expect(
      text.slice(restriction.conditionStart, restriction.conditionEnd),
    ).toBe("12至18歲");
    for (const anchor of restriction.anchors)
      expect(text.slice(anchor.start, anchor.end)).toBe(anchor.text);
    expect(text.slice(restriction.start, restriction.end)).not.toContain(
      "藥品請妥善保存",
    );
    expect(
      restriction.unresolved.some(
        (range) => range.reason === "causal_subject_boundary_unresolved",
      ),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved(
        "有多重創傷或近期大範圍外科手術者，使用前請先諮詢醫師。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "12至18歲並有多重創傷或近期大範圍外科手術者，使用前請先諮詢醫師。",
        [text],
      ),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved("12至18歲或有多重創傷者，請先諮詢。", [
        text,
      ]),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "任何年齡，包括12至18歲，有多重創傷者使用前應洽醫師。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "不限年齡，包括12至18歲，有多重創傷者使用前應洽醫師。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "不是所有年齡，只有12至18歲且有多重創傷者應先洽醫師。",
        [text],
      ),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved("任何年齡都應妥善保管藥品。", [text]),
    ).toBe(true);
    expect(sourceInheritedScopePreserved("產婦請先諮詢醫師。", [text])).toBe(
      true,
    );
    expect(
      sourceInheritedScopePreserved(
        "吸菸所引起之持續或慢性咳嗽的人，使用前請先諮詢醫師。",
        [text],
      ),
    ).toBe(false);
    expect(sourceInheritedScopePreserved("藥品請妥善保存。", [text])).toBe(
      true,
    );
    expect(
      sourceInheritedScopePreserved(
        "12至18歲有合成甲病應先諮詢。多重創傷者應先諮詢。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "多重創傷者應先諮詢；12至18歲有合成甲病應先諮詢。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "12至18歲且吸菸所引起之持續或慢性咳嗽的人，應先諮詢。",
        [text],
      ),
    ).toBe(false);
  });

  it("preserves a shared persistence tail without applying it to the preceding independent list", () => {
    const text =
      "【副作用】若心跳每分鐘少於50次或發燒及喉嚨痛，應予醫療照應。如有手腳冰冷；下瀉；異常疲倦；睡眠問題持續時，也應予醫療照應。";
    expect(sourceInheritedRestrictions(text).map((item) => item.kind)).toEqual([
      "tail",
    ]);
    expect(
      sourceInheritedScopePreserved("若有手腳冰冷，應予醫療照應。", [text]),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved("若手腳冰冷持續，應予醫療照應。", [text]),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved("手腳冰冷不需持續，出現就應予醫療照應。", [
        text,
      ]),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved(
        "手腳冰冷不必症狀持續，出現就應予醫療照應。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved("不必持續放在手邊，藥品應妥善保管。", [
        text,
      ]),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved("若下瀉持續，應予醫療照應。", [text]),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved("心跳每分鐘少於50次，應予醫療照應。", [
        text,
      ]),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved("若有發燒及喉嚨痛，應予醫療照應。", [text]),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved(
        "手腳冰冷應予醫療照應；睡眠問題持續時也應醫療照應。",
        [text],
      ),
    ).toBe(false);
  });

  it("requires an inherited exception for both children without applying it to an unrelated absolute allergy rule", () => {
    const text =
      "【警語】\n一、除非有醫師藥師藥劑生指示，請遵循下列情況服用：\n合成甲病者不建議使用。合成乙症者不得使用。\n二、對Acetaminophen過敏者切勿使用該成分。";
    expect(sourceInheritedScopePreserved("合成乙症者不得使用。", [text])).toBe(
      false,
    );
    expect(
      sourceInheritedScopePreserved(
        "除非有醫師、藥師或藥劑生指示，合成乙症者不得使用。",
        [text],
      ),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved(
        "除非有醫師藥師藥劑生指示，合成甲病者不建議使用。合成乙症者不得使用。",
        [text],
      ),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved("對Acetaminophen過敏者切勿使用該成分。", [
        text,
      ]),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved(
        "對Acetaminophen過敏者，除非有醫師藥師藥劑生指示，否則不得使用該成分。",
        [text],
      ),
    ).toBe(false);
  });

  it("keeps unresolved chronic cough raw-only and does not alter absolute ingredient allergy", () => {
    const actual = (suffix: string, section: string) =>
      sourcePassages(
        frozen.find((item) => item.licenseNo.includes(suffix))!.chunks,
      ).find((item) => item.sourceSection === section)!.quote;
    const usage = actual("018498", "使用上注意事項");
    const cough =
      "吸菸、氣喘、慢性阻塞性肺疾病（如慢性氣管炎或肺氣腫）所引起之持續或慢性咳嗽的人，使用前請洽醫師診治。";
    expect(sourceInheritedScopePreserved(cough, [usage])).toBe(false);
    expect(sourceInheritedScopePreserved("12至18歲且因" + cough, [usage])).toBe(
      false,
    );
    const warning = actual("051528", "警語及注意事項");
    expect(
      sourceInheritedScopePreserved(
        "曾對Acetaminophen過敏的人切勿使用含Acetaminophen的藥品。",
        [warning],
      ),
    ).toBe(true);
    expect(
      sourceInheritedScopePreserved(
        "對Acetaminophen過敏的人，除非有醫師藥師藥劑生指示，否則不得使用。",
        [warning],
      ),
    ).toBe(false);
  });

  it("allows only the correct answer to inherit a question's validated context for the same source item", () => {
    const age =
      "【警語】\n一、12至18歲，並有下列情形的人：多重創傷。合成神經疾病。\n二、請妥善保管。";
    expect(
      sourceQuizInterpretationExplicit(
        "依警語，12至18歲且有多重創傷者應怎麼做？",
        "多重創傷者使用前洽醫師。",
        [age],
      ),
    ).toBe(true);
    expect(
      sourceQuizInterpretationExplicit(
        "依警語，多重創傷者應怎麼做？",
        "多重創傷者使用前洽醫師。",
        [age],
      ),
    ).toBe(false);
    expect(
      sourceQuizInterpretationExplicit(
        "依警語，12至18歲且有多重創傷者應怎麼做？",
        "所有年齡的多重創傷者使用前洽醫師。",
        [age],
      ),
    ).toBe(false);
    expect(
      sourceQuizInterpretationExplicit(
        "依警語，12至18歲且有多重創傷者應怎麼做？",
        "使用前洽醫師。合成神經疾病者也應如此。",
        [age],
      ),
    ).toBe(false);
    const tail =
      "【副作用】如有手腳冰冷；下瀉；睡眠問題持續時，也應予醫療照應。";
    expect(
      sourceQuizInterpretationExplicit(
        "依副作用欄，手腳冰冷持續時應如何處理？",
        "手腳冰冷的情境應予醫療照應。",
        [tail],
      ),
    ).toBe(true);
    expect(
      sourceQuizInterpretationExplicit(
        "依副作用欄，手腳冰冷持續時應如何處理？",
        "下瀉出現時應予醫療照應。",
        [tail],
      ),
    ).toBe(false);
    expect(
      sourceQuizInterpretationExplicit(
        "依副作用欄，手腳冰冷持續時應如何處理？",
        "手腳冰冷只要出現就應予醫療照應。",
        [tail],
      ),
    ).toBe(false);
  });

  it("does not certify a flattened unresolved source boundary even when every generated lesson passes model checks", async () => {
    const original = field(
      "【警語】12至18歲，並有下列情形的人：多重創傷。吸菸所引起之持續或慢性咳嗽的人。",
      "UNRESOLVED-FLAT-SCOPE",
    );
    const plan = prepareTeachingPlan([original]);
    const input = teachingPlanInput(plan)[0];
    const draft = {
      ...draftFor(input),
      lessons: [
        {
          text: "12至18歲並有多重創傷者，原文要求使用前應先諮詢醫師。",
          spanIds: ["r0"],
        },
        {
          text: "吸菸所引起之持續或慢性咳嗽的人，原文要求使用前先諮詢醫師。",
          spanIds: ["r0"],
        },
      ],
      quiz: [],
    };
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draft],
      "警語",
      "chat",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toContain("多重創傷");
    expect(result.coverage!.fields[0].status).toBe("partial");
    expect(result.coverage!.fields[0].explainedSpanCount).toBe(0);
    expect(result.completeFields).toEqual([]);
  });

  it("does not let a verbatim whole scoped list approve a separate appended assertion", async () => {
    const original = field(
      "【警語】\n一、12至18歲，並有下列情形的人：合成甲病。多重創傷或近期大範圍外科手術。\n二、請妥善保管。",
      "EXACT-RESOLVED-AGE",
    );
    const restriction = sourceInheritedRestrictions(original.quote).find(
      (item) => item.kind === "age",
    )!;
    const full = original.quote.slice(
      restriction.conditionStart,
      restriction.end,
    );
    const bad =
      full + "\n有多重創傷或近期曾進行大範圍外科手術者，使用前請洽醫師診治。";
    expect(sourceInheritedScopePreserved(full, [original.quote])).toBe(true);
    expect(sourceInheritedScopePreserved(bad, [original.quote])).toBe(false);
    expect(
      sourceInheritedScopePreserved("有多重創傷者使用前洽醫師。\n" + full, [
        original.quote,
      ]),
    ).toBe(false);
    const plan = prepareTeachingPlan([original]);
    const input = teachingPlanInput(plan)[0];
    const safe = "藥品應妥善保管，以防止兒童誤食。";
    const draft = {
      ...draftFor(input),
      lessons: [
        { text: bad, spanIds: input.coverageLedger.map((range) => range.id) },
        { text: safe, spanIds: input.coverageLedger.map((range) => range.id) },
      ],
      quiz: [],
    };
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draft],
      "原文明列的注意事項",
      "chat",
    );
    expect(result.claims.map((claim) => claim.text)).toEqual([safe]);
    expect(result.completeFields).toEqual([]);
  });

  it("holds an unresolved causal child even without age while preserving the complete original reading", async () => {
    const raw =
      "【注意事項】有下列情形者使用前請洽醫師診治。12至18歲，並有下列情形的人：氣喘所引起之呼吸困難的人。";
    const original = field(raw, "UNRESOLVED-IMMEDIATE-CHILD");
    const bad = "因氣喘所引起之呼吸困難的人，使用前請洽醫師診治。";
    expect(sourceInheritedScopePreserved(bad, [original.quote])).toBe(false);
    expect(
      sourceInheritedScopePreserved("12至18歲且" + bad, [original.quote]),
    ).toBe(false);
    expect(
      sourceInheritedScopePreserved("氣喘所引起之呼吸困難的人。", [
        original.quote,
      ]),
    ).toBe(false);
    const plan = prepareTeachingPlan([original]);
    const input = teachingPlanInput(plan)[0];
    const draft = { ...draftFor(input, bad), quiz: [] };
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draft],
      "注意事項",
      "chat",
    );
    expect(result.claims).toEqual([]);
    expect(result.completeFields).toEqual([]);
    const chunk = page(raw, "UNRESOLVED-IMMEDIATE-CHILD");
    const reading = completeRequestedChatCoverage(
      "請說明注意事項",
      [chunk],
      [chunk],
      [original],
      [],
      undefined,
      result.completeFields,
    );
    expect(reading.incomplete).toBe(true);
    expect(reading.sourceReading!.sections[0].citations).toEqual(
      passageCitations(original),
    );
    expect(reading.sourceReading!.sections[0].citations[0].quote).toBe(raw);
  });

  it.each([
    {
      kind: "tail",
      quote: "【副作用】如有手腳冰冷；下瀉；睡眠問題持續時，也應予醫療照應。",
      bad: "手腳冰冷應予醫療照應。",
    },
    {
      kind: "exception",
      quote:
        "【警語】\n一、除非有醫師指示，請遵循下列情況服用：\n合成甲病者不得使用。合成乙症者不得使用。\n二、請妥善保管。",
      bad: "合成乙症者不得使用。",
    },
  ])(
    "scopes an exact $kind list allowance only to that text, not an appended or prefixed claim",
    async ({ kind, quote, bad }) => {
      const restriction = sourceInheritedRestrictions(quote).find(
        (item) => item.kind === kind,
      )!;
      const full = quote.slice(
        Math.min(restriction.conditionStart, restriction.start),
        Math.max(restriction.conditionEnd, restriction.end),
      );
      expect(sourceInheritedScopePreserved(full, [quote])).toBe(true);
      expect(sourceInheritedScopePreserved(full + "。" + bad, [quote])).toBe(
        false,
      );
      expect(sourceInheritedScopePreserved(bad + "。" + full, [quote])).toBe(
        false,
      );
      const original = field(quote, "EXACT-LIST-" + kind);
      const plan = prepareTeachingPlan([original]);
      const input = teachingPlanInput(plan)[0];
      const draft = { ...draftFor(input, full + "。" + bad), quiz: [] };
      const result = await reviewTeachingPlan(
        approve,
        plan,
        [draft],
        "原文警語",
        "chat",
      );
      expect(result.claims).toEqual([]);
      expect(result.completeFields).toEqual([]);
    },
  );

  it.each([
    {
      suffix: "010332",
      section: "副作用",
      bad: "若出現手腳冰冷、下瀉或異常疲倦，應予醫療照應。",
      good: "若手腳冰冷、下瀉或異常疲倦持續時，應予醫療照應。",
    },
    {
      suffix: "018498",
      section: "使用上注意事項",
      bad: "有多重創傷或近期曾進行大範圍外科手術者，使用前請洽醫師診治。",
      good: "12至18歲，並有多重創傷或近期曾進行大範圍外科手術者，使用前請洽醫師診治。",
    },
  ])(
    "blocks the actual omitted inherited scope with all-true model verdicts: $suffix",
    async ({ suffix, section, bad, good }) => {
      const fixture = frozen.find((item) => item.licenseNo.includes(suffix))!;
      const original = sourcePassages(fixture.chunks).find(
        (item) => item.sourceSection === section,
      )!;
      expect(sourceInheritedScopePreserved(bad, [original.quote])).toBe(false);
      expect(sourceInheritedScopePreserved(good, [original.quote])).toBe(true);
      const plan = prepareTeachingPlan([original]);
      const input = teachingPlanInput(plan)[0];
      const safe =
        suffix === "010332"
          ? "心跳每分鐘少於50次的異常緩慢時，原文要求應予醫療照應。"
          : "藥品應妥善保管，以防止兒童誤食。";
      const draft = {
        ...draftFor(input, bad),
        lessons: [
          { text: bad, spanIds: input.coverageLedger.map((range) => range.id) },
          {
            text: safe,
            spanIds: input.coverageLedger.map((range) => range.id),
          },
        ],
        quiz: [],
      };
      const result = await reviewTeachingPlan(
        approve,
        plan,
        [draft],
        "請說明原文",
        "chat",
      );
      expect(result.claims.map((claim) => claim.text)).toEqual([safe]);
      expect(result.completeFields).toEqual([]);
      expect(result.coverage!.fields[0].status).toBe("partial");
    },
  );

  it.each([
    [
      "孕婦使用前請先諮詢醫師、藥師或藥劑生。",
      "孕婦使用前請先諮詢醫師藥師藥劑生。",
      true,
    ],
    [
      "孕婦使用前請先諮詢醫師、藥師或藥劑生。",
      "孕婦使用前請先諮詢醫師藥師。",
      false,
    ],
    ["有合成甲、乙症者請勿使用。", "有合成甲\n乙症者請勿使用。", false],
    [
      "有合成甲症、合成乙症者請勿使用。",
      "有合成甲症、\n合成乙症者請勿使用。",
      true,
    ],
    ["有合成甲、乙症者請勿使用。", "有合成甲乙症者請勿使用。", false],
    ["有合成甲或乙症者請勿服用。", "有合成甲乙症者請勿服用。", false],
    ["有合成甲乙症者請勿使用。", "有合成甲乙症者請勿使用。", true],
    [
      "有合成甲症、合成乙症者請勿使用。",
      "有合成甲症、合成乙症者請勿使用。",
      true,
    ],
    ["若有不適，請停止使用。", "若有不適請停止使用。", true],
  ])(
    "does not insert a new enumeration inside an intact condition: %s",
    (text, quote, expected) => {
      expect(
        sourceConditionBoundariesPreserved(text as string, [quote as string]),
      ).toBe(expected);
    },
  );

  it.each([
    [
      "漏服時，記起後可補服。",
      "記服藥立刻追服，若與下次服藥時刻接近則勿服用。",
      false,
    ],
    ["忘記服藥後不可加倍服用。", "記服藥立刻追服，不可加倍劑量服用。", false],
    ["漏服時不可加倍服用。", "忘記服藥時不可加倍服用。", true],
    ["漏服時不可加倍服用。", "若未按時服藥，不可加倍服用。", true],
  ])(
    "requires an explicit missed-dose situation instead of repairing incomplete wording: %s",
    (text, quote, expected) => {
      expect(sourceSituationExplicit(text as string, [quote as string])).toBe(
        expected,
      );
    },
  );

  it("isolates a malformed field without losing another valid canonical field", async () => {
    const first = field("【警語】若有合成甲反應，應停止使用。", "FIELD-A");
    const second = field("【警語】若有合成乙反應，應停止使用。", "FIELD-B");
    const plan = prepareTeachingPlan([first, second]);
    const inputs = teachingPlanInput(plan);
    const good = draftFor(
      inputs[1],
      "若有合成乙反應，原文明示應停止使用，不能繼續。",
    );
    const raw = OutputSchema.parse({
      status: "supported",
      claims: [],
      quiz: [],
      fieldTeaching: [
        { fieldId: inputs[0].fieldId, lessons: "malformed" },
        good,
      ],
    });
    expect(raw.fieldTeaching).toHaveLength(2);
    const result = await reviewTeachingPlan(
      approve,
      plan,
      raw.fieldTeaching,
      "警語",
      "chat",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].citations).toEqual(passageCitations(second));
    expect(result.coverage!.fields[0].status).toBe("unavailable");
    expect(result.coverage!.fields[1].status).toBe("complete");
    expect(result.completeFields).toEqual([second]);
  });

  it.each([11, 16, 17])(
    "independently reviews a bounded prefix of %s lessons without falsely completing overflow",
    async (count) => {
      const first = field("【警語】若有合成甲反應，應停止使用。", "FIELD-A");
      const second = field("【警語】若有合成乙反應，應停止使用。", "FIELD-B");
      const plan = prepareTeachingPlan([first, second]);
      const inputs = teachingPlanInput(plan);
      const draft = draftFor(
        inputs[0],
        "若有合成甲反應，原文明示應停止使用，不能繼續。",
      );
      draft.lessons = Array.from({ length: count }, () => ({
        ...draft.lessons[0],
      }));
      const good = draftFor(
        inputs[1],
        "若有合成乙反應，原文明示應停止使用，不能繼續。",
      );
      let reviewedLessons = 0;
      const result = await reviewTeachingPlan(
        {
          json: async (_system, input: any) => {
            reviewedLessons = input.checks.filter(
              (check: any) =>
                check.fieldId === inputs[0].fieldId &&
                check.checkType === "lesson",
            ).length;
            return approve.json(_system, input);
          },
        },
        plan,
        [draft, good],
        "警語",
        "chat",
      );
      expect(reviewedLessons).toBe(Math.min(count, 16));
      expect(result.claims).toHaveLength(Math.min(count, 16) + 1);
      expect(result.coverage!.fields[0].status).toBe(
        count <= 16 ? "complete" : "partial",
      );
      expect(result.completeFields.some((item) => item === first)).toBe(
        count <= 16,
      );
      if (count > 16) {
        expect(result.coverage!.fields[0].reason).toBe("generation_overflow");
        expect(result.coverage!.fields[0].explainedSpanCount).toBe(0);
        expect(FieldTeachingDraftSchema.safeParse(draft).success).toBe(false);
      }
      expect(result.coverage!.fields[1].status).toBe("complete");
    },
  );

  it("keeps original lesson indices in an overflow prefix and rejects quizzes linked to omitted or rejected lessons", async () => {
    const original = field(
      "【警語】若有合成甲反應，應停止使用。",
      "FIELD-OVERFLOW",
    );
    const plan = prepareTeachingPlan([original]);
    const input = teachingPlanInput(plan)[0];
    const draft = draftFor(
      input,
      "若有合成甲反應，原文明示應停止使用，不可繼續使用。",
    );
    draft.lessons = Array.from({ length: 17 }, () => ({ ...draft.lessons[0] }));
    draft.lessons[0] = { ...draft.lessons[0], spanIds: ["unknown-range"] };
    draft.quiz = [
      { ...draft.quiz[0], lessonIndices: [1] },
      { ...draft.quiz[0], lessonIndices: [16] },
    ];
    let indices: number[] = [];
    const llm: Llm = {
      json: async (_system, value: any) => {
        indices = value.checks
          .filter((check: any) => check.checkType === "lesson")
          .map((check: any) => check.index);
        return approve.json(_system, value);
      },
    };
    const result = await reviewTeachingPlan(
      llm,
      plan,
      [draft],
      "警語",
      "bundle",
    );
    expect(indices).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(result.claims).toHaveLength(15);
    expect(result.quiz).toHaveLength(1);
    expect(result.quiz[0].id).toMatch(/-q0$/);
    expect(result.completeFields).toEqual([]);
    expect(result.coverage!.fields[0].status).toBe("partial");
    expect(result.coverage!.fields[0].reason).toBe("generation_overflow");
    draft.quiz = [{ ...draft.quiz[0], lessonIndices: [0] }];
    const invalidLink = await reviewTeachingPlan(
      approve,
      plan,
      [draft],
      "警語",
      "bundle",
    );
    expect(invalidLink.claims).toHaveLength(15);
    expect(invalidLink.quiz).toHaveLength(0);
    expect(invalidLink.completeFields).toEqual([]);
  });

  it("counts raw duplicate identities before parsing and never revives a valid sibling of an invalid duplicate", async () => {
    const first = field("【警語】若有合成甲反應，應停止使用。", "FIELD-A");
    const second = field("【警語】若有合成乙反應，應停止使用。", "FIELD-B");
    const plan = prepareTeachingPlan([first, second]);
    const inputs = teachingPlanInput(plan);
    const firstDraft = draftFor(
      inputs[0],
      "若有合成甲反應，原文明示應停止使用，不能繼續。",
    );
    const secondDraft = draftFor(
      inputs[1],
      "若有合成乙反應，原文明示應停止使用，不能繼續。",
    );
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [
        firstDraft,
        { fieldId: firstDraft.fieldId, lessons: "invalid" },
        { ...firstDraft, fieldId: "unknown-field" },
        secondDraft,
      ],
      "警語",
      "chat",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].citations).toEqual(passageCitations(second));
    expect(result.completeFields).toEqual([second]);
    expect(result.coverage!.fields[0].status).toBe("unavailable");
  });

  it.each([
    {
      suffix: "018498",
      section: "使用上注意事項",
      bad: "原文未提供本藥的具體建議劑量。",
      safe: "本藥應妥善保管，以防止兒童誤食。",
    },
    {
      suffix: "018498",
      section: "使用上注意事項",
      bad: "嚴重肝痛、昏睡、支氣管炎發作中或呼吸困難者請勿使用。",
      safe: "未滿12歲者不可使用本藥。",
    },
    {
      suffix: "010332",
      section: "注意事項",
      bad: "漏服時，記起後可立即補服；接近下次時間不可加倍。",
      safe: "若有支氣管氣喘，本藥切勿使用。",
    },
  ])(
    "blocks the actual published $suffix defect before an optimistic review, preserving unrelated safe education: $bad",
    async ({ suffix, section, bad, safe }) => {
      const fixture = frozen.find((item) => item.licenseNo.includes(suffix))!;
      const original = sourcePassages(fixture.chunks).find(
        (item) => item.sourceSection === section,
      )!;
      const originalQuote = original.quote;
      const plan = prepareTeachingPlan([original]);
      const input = teachingPlanInput(plan)[0];
      const allRanges = input.coverageLedger.map((range) => range.id);
      const draft = {
        ...draftFor(input),
        lessons: [
          { text: bad, spanIds: allRanges },
          { text: safe, spanIds: allRanges },
        ],
        quiz: [
          {
            q: `依${section}，哪項符合原文明示？`,
            options: [safe, "原文明示相反處理。"],
            answer: 0,
            lessonIndices: [1],
            spanIds: allRanges,
          },
          {
            q: `依${section}，哪項符合？`,
            options: [bad, "其他處理。"],
            answer: 0,
            lessonIndices: [0],
            spanIds: allRanges,
          },
        ],
      };
      const result = await reviewTeachingPlan(
        {
          json: async (system, data: any) => {
            expect(data.expectedIds).not.toContain("f0:lesson-0");
            expect(data.expectedIds).not.toContain("f0:quiz-1");
            return approve.json(system, data);
          },
        },
        plan,
        [draft],
        "完整安全欄",
        "bundle",
      );
      expect(result.claims.map((claim) => claim.text)).toEqual([safe]);
      expect(result.quiz).toHaveLength(1);
      expect(result.quiz[0].explain).toBe(safe);
      expect(result.coverage!.fields[0]).toMatchObject({
        status: "partial",
        explainedSpanCount: 0,
      });
      expect(result.completeFields).toEqual([]);
      expect(original.quote).toBe(originalQuote);
    },
  );
  it("keeps deterministic original offsets exhaustive without making numbered items independent sources", () => {
    const original = field(source + "合成說明。".repeat(80));
    const ledger = sourceCoverageLedger(original);
    expect(ledger.length).toBeGreaterThan(1);
    expect(ledger[0].start).toBe(0);
    expect(ledger.at(-1)!.end).toBe(original.quote.length);
    expect(
      ledger
        .map((range) => original.quote.slice(range.start, range.end))
        .join(""),
    ).toBe(original.quote);
    expect(
      ledger.every(
        (range) => range.text === original.quote.slice(range.start, range.end),
      ),
    ).toBe(true);
    expect(
      ledger
        .slice(1)
        .every((range, index) => range.start === ledger[index].end),
    ).toBe(true);
    expect(original.originalFieldUnitCount).toBe(1);
    expect(
      teachingPlanInput(prepareTeachingPlan([original]))[0].fullSourceField,
    ).toBe(original.quote);
  });

  it("does not reuse positive draft coverage after one of that range's lessons is rejected", async () => {
    const original = field("【警語】合成甲狀況應停止使用。合成乙狀況應就醫。");
    const plan = prepareTeachingPlan([original]);
    const draft = {
      ...draftFor(teachingPlanInput(plan)[0]),
      lessons: [
        {
          text: "原文要求合成甲狀況時停止使用，不能繼續使用。",
          spanIds: ["r0"],
        },
        { text: "合成乙狀況可以繼續使用，不必就醫。", spanIds: ["r0"] },
      ],
    };
    draft.quiz[0] = {
      ...draft.quiz[0],
      q: "依警語，合成甲狀況應如何處理？",
      options: ["停止使用", "繼續使用"],
      lessonIndices: [0],
    };
    const result = await reviewTeachingPlan(
      {
        json: async (_system, input: any) => ({
          verdicts: input.expectedIds.map((id: string) => ({
            id,
            supported: !id.endsWith(":lesson-1"),
          })),
        }),
      },
      plan,
      [draft],
      "請說明警語",
      "bundle",
    );
    expect(result.claims.map((claim) => claim.text)).toEqual([
      draft.lessons[0].text,
    ]);
    expect(result.quiz).toHaveLength(1);
    expect(result.coverage!.fields[0]).toMatchObject({
      status: "partial",
      explainedSpanCount: 0,
    });
    expect(result.completeFields).toEqual([]);
    const chat = completeRequestedChatCoverage(
      "請說明警語",
      [page("【警語】合成甲狀況應停止使用。合成乙狀況應就醫。")],
      [page("【警語】合成甲狀況應停止使用。合成乙狀況應就醫。")],
      [original],
      result.claims,
      undefined,
      result.completeFields,
    );
    expect(chat.incomplete).toBe(true);
    expect(chat.sourceReading!.sections[0].citations).toEqual(
      passageCitations(original),
    );
  });

  it.each(["unknown_span", "too_short", "raw_copy"])(
    "does not claim complete after a generation lesson is deterministically removed: %s",
    async (rejection) => {
      const original = field(
        "【警語】合成甲狀況應停止使用。" +
          "合成乙狀況須接受合成診治，不能忽略合成風險。".repeat(5),
      );
      const plan = prepareTeachingPlan([original]);
      const draft = {
        ...draftFor(teachingPlanInput(plan)[0]),
        lessons: [
          {
            text: "合成甲狀況時，原文明示應停止使用，不可繼續。",
            spanIds: ["r0"],
          },
          {
            text:
              rejection === "too_short"
                ? "短"
                : rejection === "raw_copy"
                  ? original.quote
                  : "合成乙狀況應接受合成診治，不可忽略其風險。",
            spanIds: [rejection === "unknown_span" ? "unknown" : "r0"],
          },
        ],
      };
      draft.quiz[0] = {
        ...draft.quiz[0],
        q: "合成甲狀況應如何處理？",
        options: ["停止使用", "繼續使用"],
        lessonIndices: [0],
      };
      const result = await reviewTeachingPlan(
        approve,
        plan,
        [draft],
        "警語",
        "bundle",
      );
      expect(result.claims.map((claim) => claim.text)).toEqual([
        draft.lessons[0].text,
      ]);
      expect(result.quiz).toHaveLength(1);
      expect(result.coverage!.fields[0]).toMatchObject({
        status: "partial",
        explainedSpanCount: 0,
      });
      expect(result.completeFields).toEqual([]);
    },
  );

  it("preserves distinct occurrences of the same parent exception at their original positions", () => {
    const original = field(
      "【警語】除非有合成醫師指示，合成甲類人不建議自行使用。除非有合成醫師指示，下列兩子項均不建議自行使用：合成乙類人；合成丙類人。",
    );
    const anchors = sourceScopeAnchors(original).filter((anchor) =>
      anchor.context.startsWith("除非"),
    );
    expect(anchors).toHaveLength(2);
    expect(anchors[0].start).not.toBe(anchors[1].start);
    expect(anchors[0].context).toContain("合成甲類人");
    expect(anchors[1].context).toContain("合成乙類人；合成丙類人");
  });

  it("does not cascade a parent-scope failure or incomplete range into an unrelated safe lesson and valid quiz", async () => {
    const original = field(
      "【警語】除非有合成醫師指示，以下兩項均不建議自行使用：未滿12歲；合成過敏者。若服用過量，即使無不適也應立即就醫。",
    );
    const plan = prepareTeachingPlan([original]);
    const draft = {
      ...draftFor(teachingPlanInput(plan)[0]),
      lessons: [
        {
          text: "未滿12歲的人完全不能使用，合成過敏的人也不能使用。",
          spanIds: ["r0"],
        },
        {
          text: "若服用過量，即使無不適也應立即就醫，不能等到出現不舒服才處理。",
          spanIds: ["r0"],
        },
      ],
    };
    draft.quiz[0] = {
      ...draft.quiz[0],
      q: "依警語欄，若服用過量而無不適，該怎麼做？",
      options: ["立即就醫", "等待症狀再處理"],
      lessonIndices: [1],
    };
    const result = await reviewTeachingPlan(
      {
        json: async (_system, input: any) => ({
          verdicts: input.expectedIds.map((id: string) => ({
            id,
            supported:
              !id.endsWith(":scope-0") &&
              !id.includes(":range-") &&
              !id.endsWith(":coverage"),
          })),
        }),
      },
      plan,
      [draft],
      "完整一般警語",
      "bundle",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe(draft.lessons[1].text);
    expect(result.quiz).toHaveLength(1);
    expect(result.quiz[0].explain).toBe(draft.lessons[1].text);
    expect(result.coverage!.status).toBe("partial");
    expect(result.coverage!.fields[0].explainedSpanCount).toBe(0);
  });

  it.each([
    [
      "【警語】除非有合成醫師指示，以下兩項均不建議自行使用：未滿12歲；合成過敏者。",
      "未滿12歲不可使用；合成過敏者也不可使用。",
    ],
    ["【警語】嚴重肝痛昏睡者請勿使用。", "嚴重肝病昏睡的人不可使用本藥。"],
    [
      "【警語】喉嚨疼痛持續兩日以上時，應接受合成醫師診治。",
      "喉嚨疼痛超過兩日才需要接受合成醫師診治。",
    ],
  ])(
    "requires an independent source_scope approval for the lesson's parent, original term and inclusive boundary: %s",
    async (text, explanation) => {
      const plan = prepareTeachingPlan([field(text)]);
      const result = await reviewTeachingPlan(
        {
          json: async (_system, input: any) => {
            expect(
              input.checks.some(
                (check: any) => check.checkType === "source_scope",
              ),
            ).toBe(true);
            expect(input.fields[0].fullSourceField).toBe(text);
            return {
              verdicts: input.expectedIds.map((id: string) => ({
                id,
                supported: !id.includes(":scope-"),
              })),
            };
          },
        },
        plan,
        [draftFor(teachingPlanInput(plan)[0], explanation)],
        "一般警語",
        "bundle",
      );
      expect(result.claims).toEqual([]);
      expect(result.quiz).toEqual([]);
      expect(result.completeFields).toEqual([]);
    },
  );

  it("retains independently safe equivalent punctuation while keeping a literal completeness gap explicit", async () => {
    const original = field(
      "【警語】除非有合成醫師藥師指示，以下兩項不建議自行使用：未滿12歲；合成過敏者。",
    );
    const plan = prepareTeachingPlan([original]);
    const explanation =
      "除非有合成醫師、藥師指示，未滿12歲或合成過敏的人都不建議自行使用。";
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draftFor(teachingPlanInput(plan)[0], explanation)],
      "一般警語",
      "chat",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].text).toBe(explanation);
    expect(result.coverage!.status).toBe("partial");
  });

  it("does not invent a new source_scope verdict while replaying an older boolean review", async () => {
    const plan = prepareTeachingPlan([field()]);
    const result = await reviewTeachingPlan(
      {
        json: async (_system, input: any) => ({
          verdicts: input.expectedIds
            .filter((id: string) => !id.includes(":scope-"))
            .map((id: string) => ({ id, supported: true })),
        }),
      },
      plan,
      [draftFor(teachingPlanInput(plan)[0])],
      "一般警語",
      "chat",
    );
    expect(result.claims).toEqual([]);
    expect(result.coverage!.fields[0].reason).toBe("verification_incomplete");
  });

  it.each(frozen)(
    "includes every complete safety field from actual $licenseNo within the fixed batch budget",
    ({ chunks, licenseNo }) => {
      const fields = sourcePassages(chunks).filter((item) =>
        SAFETY_SECTIONS.has(item.sourceSection || ""),
      );
      const plan = prepareTeachingPlan(fields);
      expect(
        fields.reduce((sum, item) => sum + item.quote.length, 0),
      ).toBeLessThan(MAX_TEACHING_SOURCE_CHARS);
      expect(plan.every((item) => !item.reason)).toBe(true);
      expect(
        teachingPlanInput(plan).map((item) => item.fullSourceField),
      ).toEqual(fields.map((item) => item.quote));
      for (const item of plan) {
        expect(
          item.ledger
            .map((span) => item.field.quote.slice(span.start, span.end))
            .join(""),
        ).toBe(item.field.quote);
        expect(item.field.originalFieldUnitCount).toBe(1);
      }
      if (licenseNo.includes("051528")) {
        expect(fields[0].quote.length).toBe(1720);
        expect(fields[0].modelEligible).toBe(false);
        expect(teachingScopeLiterals(fields[0])).toContain("4,000毫克");
        expect(teachingPlanInput(plan)[0].fullSourceField).toMatch(/專\s*家/u);
      }
      if (licenseNo.includes("010332")) {
        expect(fields[0].quote).toContain("19.");
        expect(passageCitations(fields[0])).toHaveLength(2);
        for (const condition of [
          "支氣管氣喘",
          "心臟性休克",
          "心臟阻斷",
          "顯著的心臟衰竭",
          "心竇性心動徐緩",
        ])
          expect(fields[0].quote).toContain(condition);
        expect(fields[1].quote).toContain("８．");
      }
      if (licenseNo.includes("018498")) {
        expect(teachingScopeLiterals(fields[0])).toContain("12至18歲");
        expect(fields[1].quote).toMatch(/皮膚\t發疹、發紅/u);
      }
    },
  );

  it("keeps purpose-only exclusions and actual requested-topic scope consistent with final coverage", () => {
    const chunks = frozen.find((item) =>
      item.licenseNo.includes("010332"),
    )!.chunks;
    const fields = sourcePassages(chunks);
    expect(
      requestedSafetyFields("只說明用途，不需要警語或交互作用", fields),
    ).toEqual([]);
    expect(
      requestedSafetyFields("不用說明個人劑量只說明用途和交互作用", fields).map(
        (item) => item.sourceSection,
      ),
    ).toEqual(["交互作用"]);
    expect(
      requestedSafetyFields("不用說明交互作用以外的資料", fields).map(
        (item) => item.sourceSection,
      ),
    ).toEqual(["交互作用"]);
    expect(
      requestedSafetyFields("用途、禁用情形及交互作用", fields).map(
        (item) => item.sourceSection,
      ),
    ).toEqual(["注意事項", "交互作用"]);
  });

  it("publishes useful reviewed plain language and a short linked explanation while retaining full immutable citations", async () => {
    const original = field();
    const plan = prepareTeachingPlan([original]);
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draftFor(teachingPlanInput(plan)[0])],
      "一般警語",
      "bundle",
    );
    expect(result.claims).toEqual([
      {
        text: plain,
        category: "warning",
        kind: "source_plain_language",
        citations: passageCitations(original),
      },
    ]);
    expect(result.completeFields).toEqual([original]);
    expect(result.coverage).toMatchObject({
      status: "complete",
      fields: [
        { status: "complete", sourceSpanCount: 1, explainedSpanCount: 1 },
      ],
    });
    expect(result.quiz).toHaveLength(1);
    expect(result.quiz[0]).toMatchObject({
      explain: plain,
      explanationKind: "verified_plain_language",
      citations: passageCitations(original),
    });
    expect(result.quiz[0].explain).not.toBe(original.quote);
    expect(result.quiz[0].q).not.toContain("逐字核對");
  });

  it("does not accept missing ledger coverage even when a reviewer mistakenly returns coverage=true", async () => {
    const original = field(source + "合成說明。".repeat(80));
    const plan = prepareTeachingPlan([original]);
    const draft = draftFor(teachingPlanInput(plan)[0]);
    draft.lessons[0].spanIds = ["r0"];
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draft],
      "警語",
      "chat",
    );
    expect(result.completeFields).toEqual([]);
    expect(result.coverage!.status).toBe("partial");
  });

  it("requires each original range's substantive facts despite all IDs and a positive whole-field verdict", async () => {
    const original = field("【警語】不可與合成甲藥併用，因為會增加合成反應。");
    const plan = prepareTeachingPlan([original]);
    const draft = draftFor(
      teachingPlanInput(plan)[0],
      "原文提醒不要合併使用合成甲藥。",
    );
    const result = await reviewTeachingPlan(
      {
        json: async (_system, input: any) => {
          const range = input.checks.find(
            (check: any) => check.checkType === "coverage_range",
          );
          expect(range.rangeId).toBe("r0");
          expect(input.fields[0].coverageLedger[0].text).toBe(original.quote);
          return {
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: !id.includes(":range-"),
            })),
          };
        },
      },
      plan,
      [draft],
      "警語",
      "chat",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.coverage!.fields[0]).toMatchObject({
      status: "partial",
      sourceSpanCount: 1,
      explainedSpanCount: 0,
    });
    expect(result.completeFields).toEqual([]);
  });

  it("allows two safe reviewed lessons to jointly explain one accounting range without dropping the emergency action or confusing two time windows", async () => {
    const original = field(
      "【警語】若誤服超過4,000毫克，即使無症狀也需立即就醫。過量24小時內可能出現合成不適，48~72小時才看見合成證據。",
    );
    const plan = prepareTeachingPlan([original]);
    const input = teachingPlanInput(plan)[0];
    const draft = {
      ...draftFor(input),
      lessons: [
        {
          text: "若誤服超過4,000毫克，即使無症狀也需立即就醫。這是原文明示的緊急處理要求，不能等到不舒服才處理，也不是安全劑量建議。",
          spanIds: ["r0"],
        },
        {
          text: "過量後可能在24小時內出現合成不適；合成證據可能到48~72小時才看得到，這兩個時間描述不同的事情。",
          spanIds: ["r0"],
        },
      ],
    };
    draft.quiz[0].q = "依警語欄，若誤服超過4,000毫克且沒有症狀，哪項符合原文？";
    draft.quiz[0].options = ["立即就醫", "等到48~72小時再看有無症狀"];
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draft],
      "過量警語",
      "bundle",
    );
    expect(result.claims).toHaveLength(2);
    expect(result.coverage!.status).toBe("complete");
    expect(result.quiz).toHaveLength(1);
    expect(result.quiz[0].explain).toBe(draft.lessons[0].text);
  });

  it.each([
    plain.replace("未滿12歲", "兒童"),
    plain.replace("除非有醫師指示。", ""),
  ])(
    "keeps exact inherited and age scope as deterministic extra refusal gates: %s",
    async (text) => {
      const plan = prepareTeachingPlan([field()]);
      const result = await reviewTeachingPlan(
        approve,
        plan,
        [draftFor(teachingPlanInput(plan)[0], text)],
        "警語",
        "chat",
      );
      expect(result.coverage!.status).toBe("partial");
      expect(result.completeFields).toEqual([]);
    },
  );

  it("does not promote original-text copying or attaching arbitrary source IDs to plain-language completion", async () => {
    const original = field(source + "合成說明。".repeat(25));
    const plan = prepareTeachingPlan([original]);
    const input = teachingPlanInput(plan)[0];
    for (const draft of [
      draftFor(input, original.quote),
      { ...draftFor(input), fieldId: "forged-other-source" },
      {
        ...draftFor(input),
        lessons: [{ text: plain, spanIds: ["unknown-range"] }],
      },
    ]) {
      const result = await reviewTeachingPlan(
        {
          json: async () => {
            throw new Error("unusable teaching must not request review");
          },
        },
        plan,
        [draft],
        "警語",
        "chat",
      );
      expect(result.claims).toEqual([]);
      expect(result.completeFields).toEqual([]);
      expect(result.coverage!.fields[0].reason).toBe("generation_unusable");
    }
  });

  it("does not publish a quiz if any linked lesson or any option fails independent review", async () => {
    const plan = prepareTeachingPlan([field()]);
    for (const denied of [":lesson-0", ":quiz-0"]) {
      const result = await reviewTeachingPlan(
        {
          json: async (_system, input: any) => ({
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: !id.endsWith(denied),
            })),
          }),
        },
        plan,
        [draftFor(teachingPlanInput(plan)[0])],
        "警語",
        "bundle",
      );
      expect(result.quiz).toEqual([]);
      expect(result.coverage!.fields[0].quizIds).toEqual([]);
    }
  });

  it("passes the whole field, inherited scope and both options to the independent reviewer, not selected snippets", async () => {
    const original = field();
    const plan = prepareTeachingPlan([original]);
    const result = await reviewTeachingPlan(
      {
        json: async (system, input: any) => {
          expect(system).toContain("WHOLE field");
          expect(input.fields[0].fullSourceField).toBe(original.quote);
          expect(input.fields[0].requiredScopeLiterals).toContain(
            "除非有醫師指示",
          );
          expect(
            input.checks.find((check: any) => check.checkType === "quiz")
              .options,
          ).toEqual(["停止使用並就醫", "繼續使用，不必就醫"]);
          return {
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: !id.endsWith(":coverage"),
            })),
          };
        },
      },
      plan,
      [draftFor(teachingPlanInput(plan)[0])],
      "一般警語",
      "bundle",
    );
    expect(result.claims).toHaveLength(1);
    expect(result.coverage!.status).toBe("partial");
    const coverage = completeRequestedChatCoverage(
      "一般警語",
      [page(source)],
      [page(source)],
      [original],
      result.claims,
      undefined,
      result.completeFields,
    );
    expect(coverage.incomplete).toBe(true);
    expect(coverage.sourceReading!.sections[0].citations).toEqual(
      passageCitations(original),
    );
  });

  it("fails closed on missing, duplicate and unknown review IDs without publishing unreviewed lessons", async () => {
    const plan = prepareTeachingPlan([field()]);
    for (const mutate of [
      (ids: string[]) => ids.slice(1),
      (ids: string[]) => ids.map(() => ids[0]),
      (ids: string[]) => ids.map((id, index) => (index ? id : "unknown")),
    ]) {
      const result = await reviewTeachingPlan(
        {
          json: async (_system, input: any) => ({
            verdicts: mutate(input.expectedIds).map((id) => ({
              id,
              supported: true,
            })),
          }),
        },
        plan,
        [draftFor(teachingPlanInput(plan)[0])],
        "警語",
        "bundle",
      );
      expect(result.claims).toEqual([]);
      expect(result.quiz).toEqual([]);
      expect(result.coverage!.status).toBe("partial");
    }
  });

  it("does not call an explicitly incomplete generation complete solely from reviewer/ledger flags", async () => {
    const plan = prepareTeachingPlan([field()]);
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [
        {
          ...draftFor(teachingPlanInput(plan)[0]),
          status: "insufficient_data",
        },
      ],
      "警語",
      "chat",
    );
    expect(result.coverage!.status).toBe("partial");
    expect(result.completeFields).toEqual([]);
  });

  it("keeps budget-excluded whole fields unchanged and does not silently truncate text", () => {
    const long = field("【警語】" + "完整合成條件。".repeat(600));
    const longPlan = prepareTeachingPlan([long]);
    expect(teachingPlanInput(longPlan)).toEqual([]);
    expect(longPlan[0].reason).toBe("job_budget");
    expect(longPlan[0].field.quote).toBe(long.quote);
    const fields = Array.from({ length: MAX_TEACHING_FIELDS + 1 }, (_, index) =>
      field(source, "SYNTHETIC-" + index),
    );
    const plan = prepareTeachingPlan(fields);
    expect(teachingPlanInput(plan)).toHaveLength(MAX_TEACHING_FIELDS);
    expect(plan.at(-1)!.reason).toBe("job_budget");
  });

  it("does not interpret brief unresolved source fields or replace a source hold with invented lessons", () => {
    const original = {
      ...field(),
      evidenceKind: "literal_short_field" as const,
    };
    expect(teachingPlanInput(prepareTeachingPlan([original]))).toEqual([]);
    expect(() => sourcePassages([page("【禁忌】女")])).toThrowError(
      expect.objectContaining({ code: "source_requires_review" }),
    );
  });

  it("removes raw reading only after complete verified teaching for that exact publication, not another license", async () => {
    const original = field();
    const plan = prepareTeachingPlan([original]);
    const result = await reviewTeachingPlan(
      approve,
      plan,
      [draftFor(teachingPlanInput(plan)[0])],
      "警語",
      "chat",
    );
    const existing = {
      reason: "model_source_capacity" as const,
      sections: [
        { sourceSection: "警語", citations: passageCitations(original) },
      ],
    };
    expect(
      completeRequestedChatCoverage(
        "警語",
        [page(source)],
        [page(source)],
        [original],
        result.claims,
        existing,
        result.completeFields,
      ),
    ).toEqual({ incomplete: false, sourceReading: undefined });
    const other = field(source, "OTHER-PUBLICATION");
    expect(
      completeRequestedChatCoverage(
        "警語",
        [page(source)],
        [page(source)],
        [original],
        result.claims,
        existing,
        [other],
      ).incomplete,
    ).toBe(true);
  });

  it("does not revive refused responses, provider metadata, or personalized advice", async () => {
    let calls = 0;
    const result = await grounded(
      {
        json: async () => {
          calls++;
          return { status: "refused", claims: [], quiz: [], fieldTeaching: [] };
        },
      },
      "我未滿12歲，能不能使用？",
      [page("【適應症】緩解合成症狀。\n" + source)],
      {},
      "chat",
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("refused");
    expect(result.claims).toEqual([]);
    expect(result.sourceReading).toBeUndefined();
    expect(result.plainLanguageCoverage).toBeUndefined();
    const parsed = OutputSchema.parse({
      status: "supported",
      claims: [
        {
          text: plain,
          kind: "source_plain_language",
          citations: [{ chunkId: "x", quote: source }],
        },
      ],
      quiz: [],
      plainLanguageCoverage: { status: "complete" },
    });
    expect(parsed.claims[0]).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("plainLanguageCoverage");
  });

  it("retains profile comparison only after an independent relevance verdict for the same lesson, without deciding personal suitability", async () => {
    const original = field(
      "【警語】有合成氣喘病史者應留意合成反應。若出現合成呼吸不適，應就醫。",
    );
    const plan = prepareTeachingPlan([original]);
    const text =
      "這項提醒針對有合成氣喘病史的人，原文要留意合成反應；若出現合成呼吸不適，原文要求就醫。";
    const draft = draftFor(teachingPlanInput(plan)[0], text);
    const facts = [{ field: "conditions" as const, value: "合成氣喘" }];
    for (const relevant of [true, false]) {
      const result = await reviewTeachingPlan(
        {
          json: async (_system, input: any) => {
            expect(input.profileFacts).toEqual(facts);
            const check = input.checks.find(
              (item: any) => item.checkType === "personalization",
            );
            expect(check.text).toBe(text);
            expect(check.profileRefs).toEqual(facts);
            return {
              verdicts: input.expectedIds.map((id: string) => ({
                id,
                supported: !id.includes(":relevance-") || relevant,
              })),
            };
          },
        },
        plan,
        [draft],
        "一般警語",
        "chat",
        facts,
      );
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0].sourceMentions).toEqual(facts);
      expect(result.claims[0].profileRefs).toEqual(
        relevant ? facts : undefined,
      );
      expect(result.claims[0].text).not.toContain("你不能使用");
    }
  });

  it("strips forged profile facts and never converts known adult age into relevance for a child warning", async () => {
    const plan = prepareTeachingPlan([field()]);
    const draft = {
      ...draftFor(teachingPlanInput(plan)[0]),
      lessons: [
        {
          text: plain,
          spanIds: ["r0"],
          profileRefs: [
            { field: "conditions" as const, value: "捏造的疾病" },
            { field: "age" as const, value: "40" },
          ],
        },
      ],
    };
    const result = await reviewTeachingPlan(
      {
        json: async (_system, input: any) => {
          const check = input.checks.find(
            (item: any) => item.checkType === "personalization",
          );
          expect(check.profileRefs).toEqual([{ field: "age", value: "40" }]);
          return {
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: !id.includes(":relevance-"),
            })),
          };
        },
      },
      plan,
      [draft],
      "一般警語",
      "chat",
      [{ field: "age", value: "40" }],
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].profileRefs).toBeUndefined();
    expect(result.claims[0].sourceMentions).toBeUndefined();
  });

  it("does not resurrect a rejected teaching claim because its personalization verdict is true", async () => {
    const original = field("【警語】有合成氣喘病史者應留意合成反應。");
    const plan = prepareTeachingPlan([original]);
    const draft = draftFor(
      teachingPlanInput(plan)[0],
      "合成氣喘相關的提醒，原文記載需要留意合成反應。",
    );
    const result = await reviewTeachingPlan(
      {
        json: async (_system, input: any) => ({
          verdicts: input.expectedIds.map((id: string) => ({
            id,
            supported: !id.includes(":lesson-"),
          })),
        }),
      },
      plan,
      [draft],
      "一般警語",
      "chat",
      [{ field: "conditions", value: "合成氣喘" }],
    );
    expect(result.claims).toEqual([]);
    expect(result.quiz).toEqual([]);
    expect(result.completeFields).toEqual([]);
  });

  it.each([
    "ai_timeout",
    "ai_auth_error",
    "ai_quota_exceeded",
    "ai_output_limit",
  ])(
    "propagates transport/config failure %s rather than disguising it as safe source reading",
    async (code) => {
      await expect(
        grounded(
          {
            json: async () => {
              throw new AppError(code, "bounded test", 503);
            },
          },
          "一般警語",
          [page(source)],
          {},
          "chat",
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it("runs one generation then two bounded independent reviews concurrently and publishes a genuine explanation instead of raw-only fallback", async () => {
    let calls = 0;
    const reviews: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: Llm = {
      json: async (system, input: any) => {
        calls++;
        if (!input.expectedIds) {
          expect(input.teachingFields).toHaveLength(1);
          const purpose = input.sources.find(
            (item: any) => item.purposeEligible,
          );
          return {
            status: "supported",
            claims: [
              {
                text: "這藥用來緩解合成症狀。",
                category: "purpose",
                citations: [{ sourceId: purpose.id }],
              },
            ],
            quiz: [],
            fieldTeaching: input.teachingFields.map((item: any) =>
              draftFor(item),
            ),
          };
        }
        reviews.push(input.checks ? "whole-field" : "legacy");
        if (reviews.length === 2) release();
        await barrier;
        return {
          verdicts: input.expectedIds.map((id: string) => ({
            id,
            supported: true,
          })),
        };
      },
    };
    const result = await grounded(
      llm,
      "請說明用途與一般警語",
      [page("【適應症】緩解合成症狀。\n" + source)],
      {},
      "chat",
    );
    expect(calls).toBe(3);
    expect(reviews.sort()).toEqual(["legacy", "whole-field"]);
    expect(result.status).toBe("supported");
    expect(result.sourceReading).toBeUndefined();
    expect(
      result.claims.some(
        (claim) =>
          claim.kind === "source_plain_language" && claim.text === plain,
      ),
    ).toBe(true);
    expect(result.plainLanguageCoverage!.status).toBe("complete");
    expect(
      result.plainLanguageCoverage!.fields[0].claimIndices.every(
        (index) => result.claims[index].kind === "source_plain_language",
      ),
    ).toBe(true);
    expect(result.quiz).toEqual([]);
  });

  it("discards an unquoted duplicate legacy warning without failing independently valid purpose and whole-field teaching", async () => {
    const result = await grounded(
      {
        json: async (_system, input: any) => {
          if (input.expectedIds)
            return {
              verdicts: input.expectedIds.map((id: string) => ({
                id,
                supported: true,
              })),
            };
          const purpose = input.sources.find(
            (item: any) => item.purposeEligible,
          );
          return {
            status: "supported",
            claims: [
              {
                text: "不應被發布的無引用重複警語。",
                category: "warning",
                citations: [],
              },
              {
                text: "這藥用來緩解合成症狀。",
                category: "purpose",
                citations: [{ sourceId: purpose.id }],
              },
            ],
            quiz: [
              {
                q: "依仿單適應症欄的用途，哪項符合？",
                options: ["緩解合成症狀", "只作合成包裝"],
                answer: 0,
                claimIndex: 1,
                learningObjective: "purpose",
                sourceSection: purpose.sourceSection,
                requiredConditions: [],
                citations: [{ sourceId: purpose.id }],
              },
            ],
            fieldTeaching: input.teachingFields.map((item: any) =>
              draftFor(item),
            ),
          };
        },
      },
      "用途及警語",
      [page("【適應症】緩解合成症狀。\n" + source)],
      {},
      "bundle",
    );
    expect(result.status).toBe("supported");
    expect(
      result.claims.some((claim) => claim.text.includes("無引用重複")),
    ).toBe(false);
    expect(
      result.claims.some(
        (claim) =>
          claim.category === "purpose" && claim.kind !== "source_exact_purpose",
      ),
    ).toBe(true);
    expect(
      result.claims.some((claim) => claim.kind === "source_plain_language"),
    ).toBe(true);
    expect(
      result.claims.some((claim) => claim.kind === "source_exact_safety"),
    ).toBe(true);
    expect(result.sourceReading).toBeUndefined();
    expect(result.plainLanguageCoverage!.status).toBe("complete");
    expect(
      result.quiz.some(
        (question) =>
          question.learningObjective === "warning" &&
          question.explanationKind === "verified_plain_language",
      ),
    ).toBe(true);
    expect(result.rejectedCount).toBe(1);
  });

  it("settles both independent reviews and their usage work before propagating one review failure", async () => {
    let teachingFinished = false;
    const pending = grounded(
      {
        json: async (_system, input: any) => {
          if (!input.expectedIds) {
            const purpose = input.sources.find(
              (item: any) => item.purposeEligible,
            );
            return {
              status: "supported",
              claims: [
                {
                  text: "這藥用來緩解合成症狀。",
                  category: "purpose",
                  citations: [{ sourceId: purpose.id }],
                },
              ],
              quiz: [],
              fieldTeaching: input.teachingFields.map((item: any) =>
                draftFor(item),
              ),
            };
          }
          if (!input.checks)
            throw new AppError("ai_timeout", "bounded test", 503);
          await new Promise((resolve) => setTimeout(resolve, 10));
          teachingFinished = true;
          return {
            verdicts: input.expectedIds.map((id: string) => ({
              id,
              supported: true,
            })),
          };
        },
      },
      "用途及警語",
      [page("【適應症】緩解合成症狀。\n" + source)],
      {},
      "chat",
    );
    await expect(pending).rejects.toMatchObject({ code: "ai_timeout" });
    expect(teachingFinished).toBe(true);
  });

  it("does not count original-text attribution or absence-of-information as useful safety quizzes", () => {
    expect(
      safetyReadingQuestion(
        field("【警語】本品具有合成注意內容，應由專業人員評估。"),
      ),
    ).toBeUndefined();
    expect(
      safetyReadingQuestion(field("【警語】目前尚無資訊。")),
    ).toBeUndefined();
  });
});
