import { describe, expect, it } from "vitest";
import {
  grounded,
  sourcePassages,
  citationsValid,
  sourceDetailsExplicit,
  GROUNDING_VERSION,
  type Llm,
} from "../server/ai";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { AppError } from "../server/config";
import {
  profileFacts,
  warningConditions,
  warningConditionsPreserved,
} from "../shared/learning";
import type {
  Chunk,
  Drug,
  GroundedResult,
  Identity,
  LearningRecord,
} from "../shared/schema";

const chunk: Chunk = {
  id: "synthetic",
  licenseNo: "SYNTHETIC-LEARNING",
  version: "v1",
  page: 1,
  start: 0,
  text: "注意事項：這是合成流程測試資料；合成情境A的讀者應閱讀說明，不可當成醫療依據。",
};
const citations = [{ chunkId: chunk.id, quote: chunk.text }];
const claim = {
  text: "合成情境A的讀者應閱讀說明。",
  category: "warning" as const,
  citations,
};
const quiz = [0, 1].map((i) => ({
  id: "q" + i,
  q: "依注意事項，合成情境A的讀者可將合成文件當成醫療依據嗎？" + i,
  options: ["不可以", "可以"],
  answer: 0,
  explain: "合成情境A的讀者應閱讀說明，不可當成醫療依據。",
  citations,
  claimIndex: 0,
  learningObjective: "warning" as const,
  sourceSection: "注意事項" as const,
  requiredConditions: ["合成情境A的讀者"],
}));
const result: GroundedResult = {
  status: "supported",
  claims: [claim],
  chunks: [chunk],
  quiz,
  followups: [],
  rejectedCount: 0,
  sourceVersions: { [chunk.licenseNo]: "v1" },
  verification: "model_assisted",
};
const ref = { field: "conditions" as const, value: "合成情境A" };

describe("verified personalization and task output", () => {
  it("keeps short source sentences in contiguous passages without inventing headings", () => {
    const original = {
      ...chunk,
      text: "這是供測試核對的完整前句。用途：測試。\n二、這是另一段完整的原始警語。短句。",
    };
    const sources = sourcePassages([original]);
    expect(sources.map((s) => s.quote).join("")).toBe(original.text);
    expect(
      sources.every((s) =>
        citationsValid(
          { text: "", citations: [{ chunkId: s.chunkId, quote: s.quote }] },
          [original],
        ),
      ),
    ).toBe(true);
    expect(
      sources.some(
        (s) => s.quote.includes("用途：測試。") && s.quote.includes("二、"),
      ),
    ).toBe(true);
  });
  it("resolves only local source IDs to original quotes and still rejects unsupported conclusions", async () => {
    let checked: any;
    const llm: Llm = {
      json: async (system, input: any) => {
        if (system.includes("審核器")) {
          checked = input;
          return {
            verdicts: input.claims.map((c: any) => ({
              id: c.id,
              supported: false,
            })),
          };
        }
        return {
          status: "supported",
          claims: [
            {
              text: "原文未支持的結論",
              citations: [{ sourceId: input.sources[0].id }],
            },
          ],
        };
      },
    };
    const r = await grounded(llm, "合成問題", [chunk], {}, "bundle");
    expect(checked.claims[0].citations).toEqual(citations);
    expect(r.claims).toEqual([]);
    expect(r.rejectedCount).toBe(1);
  });
  it("rejects unknown or ambiguous source references without accepting model-written quotes", async () => {
    for (const reference of [
      { sourceId: "other-request" },
      { sourceId: "s0", quote: chunk.text },
      { sourceId: "s0", chunkId: "different" },
    ]) {
      await expect(
        grounded(
          {
            json: async () => ({
              status: "supported",
              claims: [{ text: "合成", citations: [reference] }],
            }),
          },
          "合成問題",
          [chunk],
          {},
          "bundle",
        ),
      ).rejects.toMatchObject({ code: "invalid_ai_output" });
    }
  });
  it("blocks ingredient-derived warnings even when a model would approve them", async () => {
    const ingredients = { ...chunk, text: "合成品成分：測試物甲、測試物乙。" };
    let verificationCalled = false;
    const r = await grounded(
      {
        json: async (system, input: any) => {
          if (system.includes("審核器")) {
            verificationCalled = true;
            return {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: true,
              })),
            };
          }
          return {
            status: "supported",
            claims: [
              {
                text: "對測試物甲過敏者應停止使用。",
                category: "warning",
                citations: [{ sourceId: input.sources[0].id }],
              },
            ],
          };
        },
      },
      "注意事項",
      [ingredients],
      {},
      "bundle",
    );
    expect(verificationCalled).toBe(false);
    expect(r.claims).toEqual([]);
    expect(r.rejectedCount).toBe(1);
  });
  it("rejects shared top-level citations instead of assigning them to unsupported claims", async () => {
    const llm: Llm = {
      json: async () => ({
        status: "supported",
        claims: [{ text: "合成提醒", category: "warning" }],
        citations,
      }),
    };
    await expect(
      grounded(llm, "合成提醒", [chunk], {}, "bundle"),
    ).rejects.toMatchObject({ code: "invalid_ai_output" });
  });
  it("uses only explicit health fields and excludes unknown values, notes and identity", () => {
    expect(profileFacts(null)).toEqual([]);
    expect(
      profileFacts({
        age: null,
        sex: "unspecified",
        pregnancy: "unknown",
        conditions: [],
        allergies: "",
      }),
    ).toEqual([]);
    expect(
      profileFacts({
        age: 32,
        conditions: ["合成情境A"],
        notes: "推測另一種病史",
        displayName: "測試",
      }),
    ).toEqual([{ field: "age", value: "32" }, ref]);
  });
  it("retains verified relevance and maps reordered verdict IDs", async () => {
    const llm: Llm = {
      json: async (system, input: any) =>
        system.includes("審核器")
          ? {
              verdicts: [...input.claims]
                .reverse()
                .map((c: any) => ({ id: c.id, supported: true })),
            }
          : { status: "supported", claims: [{ ...claim, profileRefs: [ref] }] },
    };
    const r = await grounded(
      llm,
      "合成提醒",
      [chunk],
      { profile: { conditions: [ref.value] } },
      "bundle",
    );
    expect(r.claims[0].profileRefs).toEqual([ref]);
  });
  it("checks literal condition candidates independently when the generator omits references", async () => {
    for (const related of [true, false]) {
      const r = await grounded(
        {
          json: async (system, input: any) =>
            system.includes("審核器")
              ? {
                  verdicts: input.claims.map((c: any) => ({
                    id: c.id,
                    supported:
                      c.checkType === "personalization" ? related : true,
                  })),
                }
              : { status: "supported", claims: [claim] },
        },
        "合成提醒",
        [chunk],
        { profile: { conditions: [ref.value] } },
        "bundle",
      );
      expect(r.claims[0].profileRefs).toEqual(related ? [ref] : undefined);
      expect(r.claims[0].sourceMentions).toEqual([ref]);
    }
  });
  it("includes every option in quiz verification and removes ambiguous questions", async () => {
    let verified: any;
    const r = await grounded(
      {
        json: async (system, input: any) => {
          if (system.includes("審核器")) {
            verified = input.claims.find((c: any) => c.checkType === "quiz");
            return {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: c.checkType !== "quiz",
              })),
            };
          }
          return { status: "supported", claims: [claim], quiz: [quiz[0]] };
        },
      },
      "合成問題",
      [chunk],
      {},
      "bundle",
    );
    expect(verified.options).toEqual(quiz[0].options);
    expect(verified.answer).toBe(quiz[0].answer);
    expect(r.quiz).toEqual([]);
    expect(r.claims).toHaveLength(1);
  });
  it("drops invented profile references before semantic verification", async () => {
    let verification: any;
    const llm: Llm = {
      json: async (system, input: any) => {
        if (system.includes("審核器")) {
          verification = input;
          return {
            verdicts: input.claims.map((c: any) => ({
              id: c.id,
              supported: true,
            })),
          };
        }
        return {
          status: "supported",
          claims: [{ ...claim, profileRefs: [ref] }],
        };
      },
    };
    const r = await grounded(
      llm,
      "合成提醒",
      [chunk],
      { profile: { conditions: ["合成情境B"] } },
      "bundle",
    );
    expect(r.claims).toEqual([claim]);
    expect(verification.claims).toHaveLength(1);
  });
  it("keeps only a literal source-mention label when personal relevance fails", async () => {
    const llm: Llm = {
      json: async (system, input: any) =>
        system.includes("審核器")
          ? {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: c.checkType !== "personalization",
              })),
            }
          : { status: "supported", claims: [{ ...claim, profileRefs: [ref] }] },
    };
    const r = await grounded(
      llm,
      "合成提醒",
      [chunk],
      { profile: { conditions: [ref.value] } },
      "bundle",
    );
    expect(r.claims).toEqual([{ ...claim, sourceMentions: [ref] }]);
    expect(r.claims[0].profileRefs).toBeUndefined();
  });
  it("never accepts provider-written source mentions or derives them from age, other claims or uncited text", async () => {
    for (const fixture of [
      {
        text: "合成情境A的讀者應閱讀說明。",
        quote: "一般讀者應閱讀說明。",
        profile: { conditions: [ref.value] },
      },
      {
        text: "一般讀者應閱讀說明。",
        quote: "合成情境A的讀者應閱讀說明。",
        profile: { conditions: [ref.value] },
      },
      {
        text: "合成情境A的讀者應閱讀說明。",
        quote: "合成情境A的讀者應閱讀說明。",
        profile: { conditions: ["合成情境B"] },
      },
      {
        text: "32歲的讀者應閱讀說明。",
        quote: "32歲的讀者應閱讀說明。",
        profile: { age: 32 },
      },
      {
        text: "A讀者應閱讀說明。",
        quote: "A讀者應閱讀說明。",
        profile: { conditions: ["A"] },
      },
      {
        text: "合成情境A的讀者應閱讀說明。",
        quote: "合成情境A的讀者應閱讀說明。",
        profile: { conditions: [ref.value] },
        category: "purpose",
      },
    ]) {
      const source = { ...chunk, text: "注意事項：" + fixture.quote };
      const r = await grounded(
        {
          json: async (system, input: any) =>
            system.includes("審核器")
              ? {
                  verdicts: input.claims.map((c: any) => ({
                    id: c.id,
                    supported: c.checkType !== "personalization",
                  })),
                }
              : {
                  status: "supported",
                  claims: [
                    {
                      text: fixture.text,
                      category:
                        "category" in fixture ? fixture.category : "warning",
                      citations: [{ chunkId: source.id, quote: source.text }],
                      sourceMentions: [ref, { field: "age", value: "32" }],
                    },
                  ],
                },
        },
        "合成提醒",
        [
          source,
          {
            ...chunk,
            id: "uncited",
            text: "注意事項：合成情境A另有記載，這一段沒有被引用。",
          },
        ],
        { profile: fixture.profile },
        "bundle",
      );
      expect(r.claims, JSON.stringify(fixture)).toHaveLength(1);
      expect(r.claims[0].sourceMentions).toBeUndefined();
      expect(r.claims[0].profileRefs).toBeUndefined();
    }
  });
  it("labels negated condition text only as a literal mention and keeps the personal relevance denial", async () => {
    const source = {
      ...chunk,
      text: "注意事項：合成情境A並非此段指定的適用條件，請閱讀完整原文。",
    };
    const r = await grounded(
      {
        json: async (system, input: any) =>
          system.includes("審核器")
            ? {
                verdicts: input.claims.map((c: any) => ({
                  id: c.id,
                  supported: c.checkType !== "personalization",
                })),
              }
            : {
                status: "supported",
                claims: [
                  {
                    text: source.text,
                    category: "warning",
                    profileRefs: [ref],
                    citations: [{ chunkId: source.id, quote: source.text }],
                  },
                ],
              },
      },
      "合成提醒",
      [source],
      { profile: { conditions: [ref.value] } },
      "bundle",
    );
    expect(r.claims[0].text).toBe(source.text);
    expect(r.claims[0].sourceMentions).toEqual([ref]);
    expect(r.claims[0].profileRefs).toBeUndefined();
  });
  it("excludes generated usage from bundles while keeping general chat usage unpersonalized", async () => {
    const use = { ...claim, category: "use" as const };
    const llm: Llm = {
      json: async (system, input: any) =>
        system.includes("審核器")
          ? {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: true,
              })),
            }
          : { status: "supported", claims: [{ ...use, profileRefs: [ref] }] },
    };
    for (const kind of ["bundle", "chat"])
      expect(
        (
          await grounded(
            llm,
            "合成用法",
            [chunk],
            { profile: { conditions: [ref.value] } },
            kind,
          )
        ).claims,
      ).toEqual(kind === "bundle" ? [] : [use]);
  });
  it("never displays a personalized claim when its general content fails verification", async () => {
    const llm: Llm = {
      json: async (system, input: any) =>
        system.includes("審核器")
          ? {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: c.checkType === "personalization",
              })),
            }
          : { status: "supported", claims: [{ ...claim, profileRefs: [ref] }] },
    };
    const r = await grounded(
      llm,
      "合成提醒",
      [chunk],
      { profile: { conditions: [ref.value] } },
      "bundle",
    );
    expect(r.claims).toEqual([]);
    expect(r.status).toBe("insufficient_data");
  });
  it("rejects missing relevance verdicts rather than assuming relevance", async () => {
    const llm: Llm = {
      json: async (system) =>
        system.includes("審核器")
          ? { verdicts: [{ id: "claim-0", supported: true }] }
          : { status: "supported", claims: [{ ...claim, profileRefs: [ref] }] },
    };
    await expect(
      grounded(
        llm,
        "合成提醒",
        [chunk],
        { profile: { conditions: [ref.value] } },
        "bundle",
      ),
    ).rejects.toMatchObject({ code: "verification_failed" });
  });
  it("allows more than two verified bundle questions and does not verify or return chat quizzes", async () => {
    const counts: number[] = [];
    const llm: Llm = {
      json: async (system, input: any) => {
        if (system.includes("審核器")) {
          counts.push(input.claims.length);
          return {
            verdicts: input.claims.map((c: any) => ({
              id: c.id,
              supported: true,
            })),
          };
        }
        return {
          status: "supported",
          claims: [claim],
          quiz: [...quiz, { ...quiz[0], id: "extra" }],
          followups: [{ question: "合成資料用途？", claimIndex: 0 }],
        };
      },
    };
    const bundle = await grounded(llm, "合成提醒", [chunk], {}, "bundle");
    expect(bundle.quiz).toHaveLength(3);
    const chat = await grounded(llm, "合成提醒", [chunk], {}, "chat");
    expect(chat.quiz).toEqual([]);
    expect(chat.followups).toEqual([]);
    expect(counts).toEqual([4, 1]);
  });
  it("returns insufficient data without calling a model when no source exists", async () => {
    const r = await grounded(
      {
        json: async () => {
          throw Error("must not call");
        },
      },
      "問題",
      [],
      {},
      "bundle",
    );
    expect(r.status).toBe("insufficient_data");
    expect(r.quiz).toEqual([]);
  });
});

describe("shared parent conditions and numbered source items", () => {
  const exception = "除非有專業人員指示";
  const child = "(二)曾因本品引起不適者不得使用。";
  const nested: Chunk = {
    ...chunk,
    text:
      "注意事項：\n一、請妥善保存此合成資料。\n二、" +
      exception +
      "，請遵循下列情況：\n(一)條件甲請洽專業人員。\n" +
      child +
      "\n（三）條件丙請洽專業人員。\n（2）條件丁請閱讀說明。\n三、其他情況請閱讀完整說明。",
  };
  it("keeps parent introductions and Chinese or Arabic child items in one contiguous quote", () => {
    const passages = sourcePassages([nested]);
    expect(passages.map((p) => p.quote).join("")).toBe(nested.text);
    const grouped = passages.find((p) => p.quote.includes(child))!;
    expect(grouped.quote).toContain(exception);
    expect(grouped.quote).toContain("(一)");
    expect(grouped.quote).toContain("（三）");
    expect(grouped.quote).toContain("（2）");
    // The entire warning field is atomic, including sibling items, so neither
    // a shared parent nor an antecedent in another item can disappear.
    expect(passages).toHaveLength(1);
    expect(grouped.quote).toBe(nested.text);
    expect(grouped.quote).toContain("三、其他");
    expect(
      passages.every((p) =>
        citationsValid(
          { text: "", citations: [{ chunkId: p.chunkId, quote: p.quote }] },
          [nested],
        ),
      ),
    ).toBe(true);
  });
  async function produce(
    text: string,
    quote: string,
    source = nested,
    sourceId = false,
  ) {
    return grounded(
      {
        json: async (system, input: any) =>
          system.includes("審核器")
            ? {
                verdicts: input.claims.map((c: any) => ({
                  id: c.id,
                  supported: true,
                })),
              }
            : {
                status: "supported",
                claims: [
                  {
                    text,
                    category: "warning",
                    citations: sourceId
                      ? [
                          {
                            sourceId: input.sources.find((s: any) =>
                              s.text.includes(child),
                            ).id,
                          },
                        ]
                      : [{ chunkId: source.id, quote }],
                  },
                ],
              },
      },
      "合成來源條件",
      [source],
      {},
      "bundle",
    );
  }
  it("rejects a direct child quote that omits its shared parent exception even if the model approves", async () => {
    expect(
      (await produce("曾因本品引起不適者不得使用。", child)).claims,
    ).toEqual([]);
    // Whitespace-normalized direct quotations must not bypass structural scope.
    expect(
      (
        await produce(
          "曾因本品引起不適者不得使用。",
          "( 二 ) 曾因本品引起不適者不得使用。",
        )
      ).claims,
    ).toEqual([]);
    expect(
      (
        await produce(
          "曾因本品引起不適者不得使用。",
          "曾因本品引起不適者不得使用。",
        )
      ).claims,
    ).toEqual([]);
  });
  it("requires the shared condition in claims using the merged original source passage", async () => {
    const complete = await produce(
      exception + "，曾因本品引起不適者不得使用。",
      "",
      nested,
      true,
    );
    expect(complete.claims).toHaveLength(1);
    expect(complete.claims[0].citations[0].quote).toContain(exception);
    expect(
      (await produce("曾因本品引起不適者不得使用。", "", nested, true)).claims,
    ).toEqual([]);
  });
  it("requires the full warning field even when a selective child has an independent numbered parent", async () => {
    const independent = {
      ...nested,
      text: nested.text + "\n四、一般說明如下：\n(一)請閱讀說明。\n" + child,
    };
    // Use a unique child text so the direct citation identifies its own parent.
    independent.text = independent.text.replace(
      child,
      "(二)其他條件請洽專業人員。",
    );
    expect(
      (await produce("曾因本品引起不適者不得使用。", child, independent))
        .claims,
    ).toHaveLength(0);
    expect(
      (await produce(independent.text, "", independent, true)).claims,
    ).toHaveLength(1);
  });
});

describe("question scope and the three acceptance counterexamples", () => {
  const purposeQuote = "適應症：袪痰。用法用量：一天4-6次。";
  const warningQuote =
    "警語：吸菸、氣喘、慢性阻塞性肺疾患（包括如慢性支氣管炎、肺氣腫）所引起之咳嗽，及伴有濃痰之咳嗽病人請勿自行使用。";
  const source = {
    ...chunk,
    text:
      "作用特點：合成鎮咳袪痰劑，可增加氣管內分泌物排泄。" +
      purposeQuote +
      warningQuote,
  };
  const purpose = {
    text: "仿單適應症為袪痰。",
    category: "purpose" as const,
    citations: [{ chunkId: source.id, quote: purposeQuote }],
  };
  const warning = {
    text: warningQuote,
    category: "warning" as const,
    citations: [{ chunkId: source.id, quote: warningQuote }],
  };
  const purposeQuestion = {
    q: "依仿單適應症欄記載的是哪一項？",
    options: ["袪痰", "鎮咳"],
    answer: 0,
    explain: "仿單適應症欄記載袪痰。",
    citations: purpose.citations,
    claimIndex: 0,
    learningObjective: "purpose",
    sourceSection: "適應症",
    requiredConditions: [],
  };
  const warningQuestion = {
    q: "依仿單警語，氣喘所引起之咳嗽病人可否自行使用？",
    options: ["請勿自行使用", "可自由使用"],
    answer: 0,
    explain: "氣喘所引起之咳嗽病人請勿自行使用。",
    citations: warning.citations,
    claimIndex: 0,
    learningObjective: "warning",
    sourceSection: "警語",
    requiredConditions: ["氣喘", "所引起之咳嗽"],
  };
  async function generate(
    claims: unknown[],
    candidate: unknown,
    selected = source,
    contentSupported = true,
  ) {
    return grounded(
      {
        json: async (system, input: any) =>
          system.includes("審核器")
            ? {
                verdicts: input.claims.map((c: any) => ({
                  id: c.id,
                  supported:
                    c.checkType === "content" ? contentSupported : true,
                })),
              }
            : { status: "supported", claims, quiz: [candidate] },
      },
      "合成理解確認",
      [selected],
      {},
      "bundle",
    );
  }
  it("rejects an ambiguous ingredient question even when the model approves it", async () => {
    const ingredientsQuote =
      "成分：每粒膠囊有效成分為Diastase、Pancreatin、Pepsin。";
    const ingredients = {
      ...chunk,
      text: ingredientsQuote + "作用：Pancreatin含有Trypsin、Lipase、Amylase。",
    };
    const c = {
      ...purpose,
      citations: [{ chunkId: ingredients.id, quote: ingredientsQuote }],
    };
    const q = {
      ...purposeQuestion,
      q: "依適應症說明本品成分中含有之酵素。",
      options: ["Diastase、Pancreatin、Pepsin", "Trypsin、Lipase、Amylase"],
      citations: c.citations,
    };
    const r = await generate([c], q, ingredients);
    expect(r.claims).toHaveLength(1);
    expect(r.quiz).toEqual([]);
  });
  it("rejects broad main-effect wording while retaining the indication-scoped correction", async () => {
    const r = await generate([purpose], {
      ...purposeQuestion,
      q: "本品主要功效為何？",
    });
    expect(r.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    expect(r.safetyCoverage?.quizCoveredSectionCount).toBe(1);
    const corrected = await generate([purpose], purposeQuestion);
    expect(corrected.quiz).toHaveLength(2);
    expect(corrected.quiz[0].q).toBe(purposeQuestion.q);
  });
  it("rejects a lost causal condition even when it was omitted from declared conditions", async () => {
    const r = await generate([warning], {
      ...warningQuestion,
      q: "依警語，對於氣喘病人，本藥使用有何注意事項？",
      requiredConditions: ["氣喘"],
    });
    expect(r.claims).toHaveLength(2);
    expect(r.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    expect(r.quiz.some((q) => q.q.includes("對於氣喘病人"))).toBe(false);
    expect(
      r.quiz
        .find((q) => q.id.startsWith("safety-"))
        ?.options.every((option) => option.includes("所引起之咳嗽")),
    ).toBe(true);
    expect(
      (await generate([warning], warningQuestion)).quiz.filter((q) =>
        q.id.startsWith("q"),
      ),
    ).toHaveLength(1);
  });
  it("uses the cited original conditions instead of an incomplete provider explanation, and rejects failed linked claims", async () => {
    const quoted = await generate([warning], {
      ...warningQuestion,
      explain: "氣喘病人請勿自行使用。",
      requiredConditions: [],
    });
    expect(quoted.quiz).toHaveLength(2);
    expect(quoted.quiz[0].explanationKind).toBe("source_quote");
    expect(quoted.quiz[0].explain).toContain("所引起之咳嗽");
    const rejected = await generate([warning], warningQuestion, source, false);
    expect(
      rejected.claims.every((claim) => claim.kind?.startsWith("source_exact_")),
    ).toBe(true);
    expect(rejected.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    expect(
      rejected.quiz.every((q) =>
        q.citations.every((citation) => source.text.includes(citation.quote)),
      ),
    ).toBe(true);
  });
  it("repairs an incorrect index only through a unique identical citation and category", async () => {
    // The real-model trace pointed its indication question at a mechanism
    // claim. The source-backed indication explanation is unambiguous here.
    for (const claimIndex of [0, 17]) {
      const r = await generate([warning, purpose], {
        ...purposeQuestion,
        claimIndex,
      });
      expect(r.quiz).toHaveLength(2);
      expect(r.quiz[0].q).toBe(purposeQuestion.q);
      expect(r.quiz[0].explain).toBe("依仿單「適應症」原文：適應症：袪痰。");
    }
    expect(
      (
        await generate([warning, purpose], purposeQuestion, source, false)
      ).quiz.filter((q) => q.id.startsWith("q")),
    ).toEqual([]);
  });
  it("refuses index repair when matching explanations are ambiguous or only partially overlap", async () => {
    const ambiguous = await generate(
      [warning, purpose, { ...purpose, text: "仿單所列用途為袪痰。" }],
      purposeQuestion,
    );
    expect(ambiguous.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    expect(ambiguous.safetyCoverage?.quizCoveredSectionCount).toBe(1);
    expect(
      (
        await generate([{ ...purpose, category: "other" }], {
          ...purposeQuestion,
          claimIndex: 17,
        })
      ).quiz.filter((q) => q.id.startsWith("q")),
    ).toEqual([]);
    const partial = await generate(
      [{ ...purpose, citations: [...purpose.citations, ...warning.citations] }],
      { ...purposeQuestion, claimIndex: 17 },
    );
    expect(partial.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    expect(
      partial.quiz.find((q) => q.id.startsWith("purpose-"))?.options,
    ).toContain("袪痰。");
  });
  it("rejects missing metadata, invalid links, duplicate options and citations from another explanation", async () => {
    for (const candidate of [
      { ...purposeQuestion, claimIndex: undefined },
      { ...purposeQuestion, claimIndex: "0" },
      { ...purposeQuestion, learningObjective: "ingredients" },
      { ...purposeQuestion, sourceSection: "作用" },
      { ...purposeQuestion, requiredConditions: undefined },
      { ...purposeQuestion, requiredConditions: [" "] },
      { ...purposeQuestion, requiredConditions: "none" },
      { ...purposeQuestion, options: ["袪痰", "袪 痰"] },
      { ...purposeQuestion, citations: warning.citations },
    ]) {
      const r = await generate([purpose], candidate);
      expect(r.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
      expect(r.claims).toHaveLength(2);
      expect(r.safetyCoverage?.quizCoveredSectionCount).toBe(1);
    }
  });
  it("does not display a personalized warning that generalizes a causal condition", async () => {
    for (const category of ["warning", "purpose", undefined]) {
      const r = await generate(
        [
          {
            ...warning,
            category,
            text: "氣喘病人請勿自行使用。",
            profileRefs: [{ field: "conditions", value: "氣喘" }],
          },
        ],
        warningQuestion,
      );
      expect(
        r.claims.some((claim) => claim.text === "氣喘病人請勿自行使用。"),
      ).toBe(false);
      expect(
        r.claims.every(
          (claim) =>
            claim.kind?.startsWith("source_exact_") &&
            !claim.profileRefs?.length,
        ),
      ).toBe(true);
      expect(r.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    }
  });
  it("preserves causal, conditional and exception clauses without requiring all OR conditions", () => {
    expect(
      warningConditionsPreserved("氣喘所引起之咳嗽病人請勿自行使用。", [
        warningQuote,
      ]),
    ).toBe(true);
    expect(
      warningConditionsPreserved("氣喘病人請勿自行使用。", [warningQuote]),
    ).toBe(false);
    expect(
      warningConditionsPreserved("孕婦不建議自行使用。", [
        "除非有醫師指示，孕婦不建議自行使用。",
      ]),
    ).toBe(false);
    expect(
      warningConditionsPreserved("除非有醫師指示，孕婦不建議自行使用。", [
        "除非有醫師指示，孕婦不建議自行使用。",
      ]),
    ).toBe(true);
    expect(
      warningConditionsPreserved("應停止使用。", [
        "若有不適情況發生，應停止使用。",
      ]),
    ).toBe(false);
  });
});

describe("compact generation with trusted source metadata", () => {
  const indication =
    "消化酵素缺乏，腹脹悶飽，身體衰弱，營養不良等症所致食慾不振或消化不良。";
  const aliasSource = {
    ...chunk,
    text:
      "【成分】每粒含有合成測試成分。\n【 用途 ( 適應症 ) 】\n" +
      indication +
      "\n【用法用量】成人一天三次，每次1～2粒。\n【包裝】1000粒以下塑膠瓶裝。",
  };
  it("identifies bracketed indication aliases and keeps dosage outside the indication citation", () => {
    const source = sourcePassages([aliasSource]);
    const purpose = source.find((s) => s.sourceSection === "用途(適應症)")!;
    expect(purpose.quote).toContain(indication);
    expect(purpose.quote).not.toContain("用法用量");
    expect(purpose.requiredConditions).toEqual([]);
    expect(source.map((s) => s.quote).join("")).toBe(aliasSource.text);
    expect(
      citationsValid(
        {
          text: "",
          citations: [{ chunkId: purpose.chunkId, quote: purpose.quote }],
        },
        [aliasSource],
      ),
    ).toBe(true);
  });
  it("carries a short indication forward while retaining its section and minimum quote length", () => {
    const source = {
      ...chunk,
      text: "作用特點：可增加氣管內分泌物排泄，具有明顯袪痰作用。\n適應症： 袪痰。\n用法用量：一天4-6次，每次間隔至少4小時。",
    };
    const passages = sourcePassages([source]);
    const purpose = passages.find((s) => s.sourceSection === "適應症")!;
    expect(purpose.quote.trim().startsWith("適應症： 袪痰。")).toBe(true);
    expect(purpose.quote).not.toContain("作用特點");
    expect(purpose.requiredConditions).toEqual([]);
    expect(
      citationsValid(
        {
          text: "",
          citations: [{ chunkId: purpose.chunkId, quote: purpose.quote }],
        },
        [source],
      ),
    ).toBe(true);
    expect(passages.map((s) => s.quote).join("")).toBe(source.text);
  });
  it("produces a publishable indication question from metadata without guessing field names or conditions", async () => {
    let generation: any;
    let prompt = "";
    let audited: any;
    const r = await grounded(
      {
        json: async (system, input: any) => {
          if (system.includes("審核器")) {
            audited = input;
            return {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: true,
              })),
            };
          }
          generation = input;
          prompt = system;
          const source = input.sources.find(
            (s: any) => s.sourceSection === "用途(適應症)",
          );
          const reference = [{ sourceId: source.id }];
          return {
            status: "supported",
            claims: [
              {
                text: "仿單適應症記載：" + indication,
                category: "purpose",
                citations: reference,
              },
            ],
            quiz: [
              {
                q: "依仿單用途(適應症)欄記載的用途是哪一項？",
                claimIndex: 0,
                learningObjective: "purpose",
                sourceSection: source.sourceSection,
                requiredConditions: source.requiredConditions,
                options: [indication, "此欄只記載包裝規格"],
                answer: 0,
                explain: "仿單適應症欄記載：" + indication,
                citations: reference,
              },
            ],
          };
        },
      },
      "仿單說明與理解確認",
      [aliasSource],
      {
        profile: {
          displayName: "不需傳送的名稱",
          notes: "不需傳送的備註",
          age: 32,
        },
        medications: [
          { name: "合成測試藥", licenseNo: chunk.licenseNo, doseAmount: 1 },
        ],
      },
      "bundle",
    );
    expect(r.claims).toHaveLength(1);
    expect(r.quiz).toHaveLength(1);
    expect(r.quiz[0].citations[0].quote).toContain(indication);
    expect(generation.sources.map((s: any) => s.sourceSection)).toEqual([
      "用途(適應症)",
    ]);
    expect(generation.context).toEqual({
      medications: [{ name: "合成測試藥", licenseNo: chunk.licenseNo }],
    });
    expect(generation.profileFacts).toEqual([{ field: "age", value: "32" }]);
    expect(prompt).toContain("claims最多2條");
    expect(audited.sourceChunks).toBeUndefined();
    expect(JSON.stringify(audited)).not.toContain("成人一天三次");
    expect(
      audited.claims.find((c: any) => c.checkType === "quiz").options,
    ).toEqual(r.quiz[0].options);
  });
  it("precomputes shared parent exceptions while retaining original child quotations", () => {
    const exception = "除非有醫師藥師藥劑生指示";
    const source = {
      ...chunk,
      text:
        "警語：\n三、" +
        exception +
        "，請遵循下列情況服用：\n( 一）3歲以下，請洽醫師診治。\n( 二 )曾經因本藥物引起過敏症狀者不得使用。",
    };
    const passage = sourcePassages([source]).find((s) =>
      s.quote.includes("過敏"),
    )!;
    expect(passage.sourceSection).toBe("警語");
    expect(passage.requiredConditions).toContain(exception);
    expect(passage.quote).toContain(exception);
    expect(warningConditions([passage.quote])).toEqual(
      passage.requiredConditions,
    );
    expect(
      warningConditionsPreserved("曾經因本藥物引起過敏症狀者不得使用。", [
        passage.quote,
      ]),
    ).toBe(false);
  });
});

describe("complete citation coverage for formulation details", () => {
  const introduction = "本品為三種消化酵素之複方製劑。";
  const indication = "適應症：合成症狀甲。";
  const source = { ...chunk, text: introduction + "\n" + indication };
  const purpose = {
    text: "仿單適應症為合成症狀甲。",
    category: "purpose" as const,
    citations: [{ chunkId: source.id, quote: indication }],
  };
  it("rejects an uncited formulation clause even when context contains it and the model approves", async () => {
    const unsupported = {
      ...purpose,
      text: "本品為三種消化酵素之複方製劑，用於合成症狀甲。",
    };
    let audited: any;
    const result = await grounded(
      {
        json: async (system, input: any) => {
          if (system.includes("審核器")) {
            audited = input;
            return {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: true,
              })),
            };
          }
          return {
            status: "supported",
            claims: [unsupported, purpose],
            quiz: [
              {
                q: "依仿單適應症欄記載的是哪一項？",
                options: ["合成症狀甲", "僅為包裝規格"],
                answer: 0,
                explain: "仿單適應症記載合成症狀甲。",
                citations: purpose.citations,
                claimIndex: 1,
                learningObjective: "purpose",
                sourceSection: "適應症",
                requiredConditions: [],
              },
            ],
          };
        },
      },
      "仿單說明與理解確認",
      [source],
      {},
      "bundle",
    );
    expect(result.claims).toEqual([purpose]);
    expect(result.quiz).toHaveLength(1);
    expect(result.rejectedCount).toBe(1);
    expect(audited.sourceChunks).toBeUndefined();
    expect(JSON.stringify(audited)).not.toContain(introduction);
    expect(audited.claims.some((c: any) => c.text === unsupported.text)).toBe(
      false,
    );
  });
  it("requires count and classification evidence in the selected quotes, while accepting equivalent number scripts", () => {
    const quoted = (text: string, quote: string) => ({
      text,
      citations: [{ chunkId: source.id, quote }],
    });
    for (const text of [
      "本品含三種消化酵素。",
      "本品為複方製劑。",
      "本品為單方製劑。",
    ])
      expect(sourceDetailsExplicit(quoted(text, indication))).toBe(false);
    expect(
      sourceDetailsExplicit(
        quoted("本品含3種消化酵素，為複方製劑。", introduction),
      ),
    ).toBe(true);
    expect(
      sourceDetailsExplicit(
        quoted("本品含三種消化酵素。", "本品含3種消化酵素。"),
      ),
    ).toBe(true);
    expect(
      sourceDetailsExplicit(
        quoted("本品含兩種消化酵素。", "本品含2種消化酵素。"),
      ),
    ).toBe(true);
    expect(
      sourceDetailsExplicit(
        quoted("本品含三種消化酵素。", "本品含2種消化酵素。"),
      ),
    ).toBe(false);
    // “一種” as an indefinite article adds no quantitative composition claim.
    expect(
      sourceDetailsExplicit(quoted("本品為一種合成測試資料。", indication)),
    ).toBe(true);
    expect(
      sourceDetailsExplicit(quoted("本品含十一種成分。", "本品含11種成分。")),
    ).toBe(true);
    expect(
      sourceDetailsExplicit(quoted("本品含二〇種成分。", "本品含20種成分。")),
    ).toBe(true);
  });
  it("replaces provider explanations with original evidence and still checks the correct answer", async () => {
    const question = {
      q: "依仿單適應症欄記載的是哪一項？",
      options: ["合成症狀甲", "三種消化酵素之複方製劑"],
      answer: 0,
      explain: "仿單適應症記載合成症狀甲。",
      citations: purpose.citations,
      claimIndex: 0,
      learningObjective: "purpose",
      sourceSection: "適應症",
      requiredConditions: [],
    };
    for (const [candidate, expectedQuestions] of [
      [question, 1],
      [
        {
          ...question,
          explain: "本品為三種消化酵素之複方製劑，用於合成症狀甲。",
        },
        1,
      ],
      [
        {
          ...question,
          options: ["三種消化酵素之複方製劑用於合成症狀甲", "其他用途"],
        },
        0,
      ],
    ] as const) {
      const r = await grounded(
        {
          json: async (system, input: any) =>
            system.includes("審核器")
              ? {
                  verdicts: input.claims.map((c: any) => ({
                    id: c.id,
                    supported: true,
                  })),
                }
              : { status: "supported", claims: [purpose], quiz: [candidate] },
        },
        "仿單說明與理解確認",
        [source],
        {},
        "bundle",
      );
      expect(r.claims).toEqual(
        expectedQuestions
          ? [purpose]
          : [
              {
                ...purpose,
                text: purpose.citations[0].quote,
                kind: "source_exact_purpose",
              },
            ],
      );
      expect(r.quiz.filter((q) => q.id.startsWith("q"))).toHaveLength(
        expectedQuestions,
      );
      expect(r.quiz).toHaveLength(1);
      if (!expectedQuestions) {
        expect(r.quiz[0].id).toMatch(/^purpose-/);
        expect(r.quiz[0].options[r.quiz[0].answer]).toBe("合成症狀甲。");
        expect(
          r.quiz[0].options.some((option) => option.includes("複方")),
        ).toBe(false);
      }
      if (r.quiz.length) {
        expect(r.quiz[0].explanationKind).toBe("source_quote");
        expect(r.quiz[0].explain).not.toContain("複方");
      }
    }
  });
});

describe("source-quote quiz explanations", () => {
  it("never publishes a free explanation borrowed from an uncited section, and does not require one from the provider", async () => {
    const indication = "適應症：袪痰。用法用量：請依標示使用。";
    const source = {
      ...chunk,
      text: indication + "警語：有高燒或出疹應洽醫師。",
    };
    const c = {
      text: "仿單適應症為袪痰。",
      category: "purpose",
      citations: [{ chunkId: source.id, quote: indication }],
    };
    for (const freeExplanation of [
      undefined,
      "高燒、出疹屬警語中應洽醫師的情況，並非本藥用途。",
    ] as const) {
      let audited: any;
      const providerQuestion = {
        q: "依仿單適應症欄記載的是哪一項？",
        options: ["袪痰", "退燒止痛"],
        answer: 0,
        explain: freeExplanation,
        claimIndex: 0,
        learningObjective: "purpose",
        sourceSection: "適應症",
        requiredConditions: [],
        citations: c.citations,
      };
      const r = await grounded(
        {
          json: async (system, input: any) => {
            if (system.includes("審核器")) {
              audited = input;
              return {
                verdicts: input.claims.map((check: any) => ({
                  id: check.id,
                  supported: true,
                })),
              };
            }
            return {
              status: "supported",
              claims: [c],
              quiz: [providerQuestion],
            };
          },
        },
        "仿單說明與理解確認",
        [source],
        {},
        "bundle",
      );
      expect(r.quiz).toHaveLength(2);
      expect(r.quiz[0].explain).toBe("依仿單「適應症」原文：適應症：袪痰。");
      expect(r.quiz[0].explanationKind).toBe("source_quote");
      expect(r.quiz[0].citations).toEqual(c.citations);
      expect(providerQuestion.explain).toBe(freeExplanation);
      expect(audited.sourceChunks).toBeUndefined();
      expect(JSON.stringify(audited)).not.toContain("高燒");
      expect(
        audited.claims.every((check: any) =>
          Array.isArray(check.parentConditions),
        ),
      ).toBe(true);
    }
  });
  it("keeps all indication sentences and conditions before the next section without shortening the stored citation", async () => {
    const quote = "適應症：合成症狀甲。僅用於成人。用法用量：請依標示使用。";
    const source = { ...chunk, text: quote };
    const c = {
      text: "適應症為成人的合成症狀甲。",
      category: "purpose",
      citations: [{ chunkId: source.id, quote }],
    };
    const r = await grounded(
      {
        json: async (system, input: any) =>
          system.includes("審核器")
            ? {
                verdicts: input.claims.map((check: any) => ({
                  id: check.id,
                  supported: true,
                })),
              }
            : {
                status: "supported",
                claims: [c],
                quiz: [
                  {
                    q: "依仿單適應症，成人適用於哪一項？",
                    options: ["成人的合成症狀甲", "其他用途"],
                    answer: 0,
                    claimIndex: 0,
                    learningObjective: "purpose",
                    sourceSection: "適應症",
                    requiredConditions: ["成人"],
                    citations: c.citations,
                  },
                ],
              },
      },
      "仿單說明與理解確認",
      [source],
      {},
      "bundle",
    );
    expect(r.quiz).toHaveLength(1);
    expect(r.quiz[0].explain).toContain("合成症狀甲。僅用於成人。");
    expect(r.quiz[0].explain).not.toContain("用法用量");
    expect(r.quiz[0].citations[0].quote).toBe(quote);
  });
});

async function setup() {
  const store = new MemoryStore();
  const d = new Domain(store);
  const identities = Object.fromEntries(
    ["owner", "other"].map((uid) => [
      uid,
      {
        uid,
        email: uid + "@example.test",
        name: uid,
        verified: true,
        admin: false,
      } satisfies Identity,
    ]),
  );
  for (const id of Object.values(identities)) await d.account(id);
  const drug: Drug = {
    licenseNo: chunk.licenseNo,
    nameZh: "合成測試藥",
    nameEn: "synthetic",
    strength: "",
    form: "錠",
    ingredients: [],
    revoked: false,
  };
  d.catalog.get = async () => drug;
  const m = await d.saveMedication("owner", {
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    confirmed: true,
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
  });
  await store.set("leaflets", "leaf", {
    id: "leaf",
    licenseNo: chunk.licenseNo,
    version: "v1",
    status: "published",
    sha256: "synthetic",
    chunks: [chunk],
  });
  await store.set("published", hash(chunk.licenseNo), { leafletId: "leaf" });
  const row: LearningRecord = {
    id: "lesson",
    ownerId: "owner",
    medicationIds: [m.id],
    medicationRevisions: [{ id: m.id, revision: m.revision }],
    profileVersion: 0,
    groundingVersion: GROUNDING_VERSION,
    result,
    answers: {},
    createdAt: new Date().toISOString(),
  };
  await store.set("learning", row.id, row);
  const app = createApp(d, async (token) => identities[token]);
  const req = (path: string, body?: unknown, uid = "owner") =>
    app.request("/api/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + uid,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { d, store, req, m, row };
}

describe("partial learning answers and persistence", () => {
  it("merges concurrent single-question answers without losing either submission", async () => {
    const { req } = await setup();
    const responses = await Promise.all([
      req("/learning/lesson/answers", { answers: { q0: 0 } }),
      req("/learning/lesson/answers", { answers: { q1: 0 } }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const { items } = await (await req("/learning")).json();
    expect(items[0].answers).toEqual({ q0: 0, q1: 0 });
    expect(items[0].progress).toMatchObject({
      status: "completed",
      total: 2,
      answered: 2,
      correct: 2,
      passed: true,
    });
  });
  it("distinguishes unanswered from incorrect, and retries without resetting a correct answer", async () => {
    const { req } = await setup();
    const first = await (
      await req("/learning/lesson/answers", { answers: { q0: 1 } })
    ).json();
    expect(first.results.map((r: any) => r.state)).toEqual([
      "incorrect",
      "unanswered",
    ]);
    await req("/learning/lesson/answers", { answers: { q1: 0 } });
    const retry = await (
      await req("/learning/lesson/answers", { answers: { q0: 0 } })
    ).json();
    expect(retry.answers).toEqual({ q0: 0, q1: 0 });
    expect(retry.progress.passed).toBe(true);
    // A new authenticated request obtains progress from the server, not component state.
    expect(
      (await (await req("/learning")).json()).items[0].progress.status,
    ).toBe("completed");
  });
  it("accepts legacy full submissions and an empty merge without resetting progress", async () => {
    const { req } = await setup();
    await req("/learning/lesson/answers", { answers: { q0: 0, q1: 0 } });
    const r = await (
      await req("/learning/lesson/answers", { answers: {} })
    ).json();
    expect(r.results).toHaveLength(2);
    expect(r.progress.passed).toBe(true);
  });
  it("rejects invalid IDs and choices atomically and isolates users", async () => {
    const { req, store } = await setup();
    for (const answers of [
      { q0: 0, unknown: 0 },
      { q0: 0, q1: 2 },
      { q0: -1 },
      { q0: 0.5 },
    ]) {
      expect((await req("/learning/lesson/answers", { answers })).status).toBe(
        400,
      );
      expect((await store.get("learning", "lesson"))?.answers).toEqual({});
    }
    expect(
      (await req("/learning/lesson/answers", { answers: { q0: 0 } }, "other"))
        .status,
    ).toBe(404);
    expect(
      (await (await req("/learning", undefined, "other")).json()).items,
    ).toEqual([]);
  });
  it("checks profile versions inside the answer transaction", async () => {
    const { d, req, store } = await setup();
    await Promise.all([
      d.profile("owner", { displayName: "合成測試", age: 32 }),
      expect(
        d.answerLearning("owner", "lesson", { answers: { q0: 0 } }),
      ).rejects.toMatchObject({ code: "stale_content" }),
    ]);
    expect((await (await req("/learning")).json()).items).toEqual([]);
    expect((await store.get("learning", "lesson"))?.answers).toEqual({});
  });
  it("retains historical answers but rejects missing or changed content rules on read and submit", async () => {
    for (const groundingVersion of [
      undefined,
      "grounded-v5.3-source-passages",
    ]) {
      const { row, req, store } = await setup();
      await store.set("learning", row.id, {
        ...row,
        groundingVersion,
        answers: { q0: 0 },
      });
      expect((await (await req("/learning")).json()).items).toEqual([]);
      const response = await req("/learning/lesson/answers", {
        answers: { q1: 0 },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "stale_content",
      });
      expect((await store.get("learning", row.id))?.answers).toEqual({ q0: 0 });
    }
  });
  it("rejects changed medication or source versions before saving an answer", async () => {
    for (const changed of ["medication", "source"]) {
      const { m, req, store } = await setup();
      if (changed === "medication")
        await store.set("medications", m.id, {
          ...m,
          revision: m.revision + 1,
        });
      else
        await store.set("leaflets", "leaf", {
          version: "v2",
          status: "published",
        });
      expect(
        (await req("/learning/lesson/answers", { answers: { q0: 0 } })).status,
      ).toBe(409);
      expect((await (await req("/learning")).json()).items).toEqual([]);
      expect((await store.get("learning", "lesson"))?.answers).toEqual({});
    }
  });
  it("allows reminders and dose logs while questions are unanswered or incorrect", async () => {
    const { d, req, m } = await setup();
    await req("/learning/lesson/answers", { answers: { q0: 1 } });
    const schedule = await d.saveSchedule("owner", {
      medicationId: m.id,
      times: ["23:59"],
      startDate: "2026-10-11",
    });
    expect(schedule.active).toBe(true);
    const rows = await d.today("owner", "2026-10-11");
    const log = await d.doseLog("owner", {
      medicationId: m.id,
      dueAt: rows[0].dueAt,
      status: "taken",
    });
    expect(log.status).toBe("taken");
  });
  it("retains the original request after a timeout and completes the same job on retry", async () => {
    const { d, m, store } = await setup();
    let first = true;
    d.llmFactory = () => ({
      json: async (system, input: any) => {
        if (first) {
          first = false;
          throw new AppError("ai_timeout", "合成逾時測試", 503);
        }
        return system.includes("審核器")
          ? {
              verdicts: input.claims.map((c: any) => ({
                id: c.id,
                supported: true,
              })),
            }
          : { status: "supported", claims: [claim] };
      },
    });
    const input = { medicationIds: [m.id], question: "合成資料限制？" };
    const job = await d.enqueueJob(
      "owner",
      true,
      "chat",
      input,
      crypto.randomUUID(),
    );
    await d.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({
      status: "failed",
      error: { code: "ai_timeout" },
      input,
    });
    await d.retryJob("owner", job.id);
    await d.processJob(job.id);
    expect(await store.get("jobs", job.id)).toMatchObject({
      status: "succeeded",
      result: { status: "supported", quiz: [] },
    });
  });
});
