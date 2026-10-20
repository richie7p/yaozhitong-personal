import { describe, expect, it } from "vitest";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import type { Chunk } from "../shared/schema";

const chunk = (text: string, id = "generic-source-a"): Chunk => ({
  id,
  licenseNo: "SYNTHETIC-SOURCE-" + id,
  version: "literal-v1",
  page: 1,
  start: 0,
  text,
});
const clinical = chunk(
  "【成分】每錠含有合成測試成分。\n效 能：\n用於治療合成症狀甲。\n用法用量：請依合成標籤使用。\n附 記：\n1. 除非有醫師指示，有合成風險者請勿自行使用。\n【儲存】置於合成保存場所。",
);
async function run(
  source: Chunk,
  change: (generation: any, input: any) => void = () => {},
  verdict = true,
) {
  let generationInput: any;
  let reviewInput: any;
  let prompt = "";
  const llm: Llm = {
    json: async (system, input: any) => {
      if (system.includes("審核器")) {
        reviewInput = input;
        return {
          verdicts: input.claims.map((c: any) => ({
            id: c.id,
            supported: verdict,
          })),
        };
      }
      prompt = system;
      generationInput = input;
      const purpose =
        input.sources.find((s: any) => s.purposeEligible) || input.sources[0];
      const warning = input.sources.find(
        (s: any) => s.sourceSection === "附記",
      );
      const result: any = {
        status: "supported",
        claims: [
          {
            text: purpose.text,
            category: "purpose",
            citations: [{ sourceId: purpose.id }],
          },
        ],
        quiz: [
          {
            q: `依仿單${purpose.sourceSection}欄記載的用途為何？`,
            claimIndex: 0,
            learningObjective: "purpose",
            sourceSection: purpose.sourceSection,
            requiredConditions: [],
            options: ["用於治療合成症狀甲", "只記載合成保存方式"],
            answer: 0,
            citations: [{ sourceId: purpose.id }],
          },
        ],
      };
      if (warning) {
        result.claims.push({
          text: warning.text,
          category: "warning",
          citations: [{ sourceId: warning.id }],
        });
        result.quiz.push({
          q: "依仿單附記欄，除非有醫師指示，有合成風險者應如何？",
          claimIndex: 1,
          learningObjective: "warning",
          sourceSection: warning.sourceSection,
          requiredConditions: warning.requiredConditions,
          options: ["請勿自行使用", "可自行改變用量"],
          answer: 0,
          citations: [{ sourceId: warning.id }],
        });
      }
      change(result, input);
      return result;
    },
  };
  const result = await grounded(
    llm,
    "仿單用途與警語及理解確認",
    [source],
    {},
    "bundle",
  );
  return { result, generationInput, reviewInput, prompt };
}

describe("actual leaflet section names and clinical purpose scope", () => {
  it("keeps 效能 and 附記 as independent literal fields rather than inheriting 成分", () => {
    const passages = sourcePassages([clinical]);
    expect(passages.map((s) => s.quote).join("")).toBe(clinical.text);
    const purpose = passages.find((s) => s.sourceSection === "效能")!;
    const warning = passages.find((s) => s.sourceSection === "附記")!;
    expect(purpose.quote).toContain("用於治療合成症狀甲");
    expect(purpose.quote).not.toContain("用法用量");
    expect(warning.quote).toContain("有合成風險者請勿自行使用");
    expect(warning.requiredConditions).toEqual(["除非有醫師指示"]);
    expect(warning.quote).not.toContain("儲存");
  });
  it("publishes clinical 效能 and 附記 questions with their own actual headings and quotes", async () => {
    const { result, generationInput, reviewInput, prompt } =
      await run(clinical);
    expect(generationInput.sources.map((s: any) => s.sourceSection)).toEqual([
      "效能",
      "附記",
    ]);
    expect(generationInput.sources[0].purposeEligible).toBe(true);
    expect(result.claims).toHaveLength(2);
    expect(result.quiz).toHaveLength(2);
    expect(result.quiz[0].explain).toMatch(/^依仿單「效能」原文：效 能：/);
    expect(result.quiz[1].explain).toMatch(/^依仿單「附記」原文：附 記：/);
    expect(result.quiz[1].explain).toContain("除非有醫師指示");
    expect(result.quiz.every((q) => q.explanationKind === "source_quote")).toBe(
      true,
    );
    expect(
      reviewInput.claims.find((c: any) => c.checkType === "content")
        .sourceSections,
    ).toEqual(["效能"]);
    expect(prompt).toContain("claims.text直接逐字照抄該完整sources.text");
  });
  it("keeps original 適應症 supported, including spaces inside Chinese heading labels", async () => {
    const source = chunk(
      "成 分：合成成分。\n適 應 症：用於治療合成症狀甲。\n用法用量：依標籤使用。\n警 語：若有合成反應，請洽醫師。",
      "generic-source-b",
    );
    const { result, generationInput } = await run(source);
    expect(generationInput.sources.map((s: any) => s.sourceSection)).toEqual([
      "適應症",
      "警語",
    ]);
    expect(result.quiz[0].explain).toMatch(/^依仿單「適應症」原文：適 應 症：/);
    expect(result.quiz[0].explain).not.toContain("成 分");
    expect(result.quiz[0].explain).not.toContain("用法用量");
  });
  it("does not rename an 效能 source to 適應症 just to pass a question", async () => {
    const { result } = await run(clinical, (generation) => {
      generation.quiz[0].q = "依仿單適應症欄記載的用途為何？";
      generation.quiz[0].sourceSection = "適應症";
    });
    expect(result.claims).toHaveLength(2);
    expect(result.quiz).toHaveLength(2);
    expect(result.quiz[0].q).toContain("附記");
    expect(
      result.quiz.some((q) => q.q === "依仿單適應症欄記載的用途為何？"),
    ).toBe(false);
    const fallback = result.quiz.find((q) => q.id.startsWith("purpose-"))!;
    expect(fallback.sourceSection).toBe("效能");
    expect(fallback.options[fallback.answer]).toBe("用於治療合成症狀甲。");
    expect(fallback.explain).toMatch(/^依仿單「效能」原文：效 能：/);
  });
  it.each(["作用", "作用特點", "作用機轉", "機轉", "藥理作用"])(
    "cannot turn a %s mechanism into a purpose even if a mock verifier says yes",
    async (section) => {
      const source = chunk(`【${section}】用於促進合成受體活性。`, "mechanism");
      const { result, generationInput } = await run(source);
      expect(generationInput.sources[0].purposeEligible).toBe(false);
      expect(result.claims).toHaveLength(0);
      expect(result.quiz).toHaveLength(0);
    },
  );
  it.each([
    "效能：增加合成受體活性與吸收濃度。",
    "效能：用於提高藥物吸收及血中濃度。",
  ])(
    "does not treat nonclinical 效能 wording as an indication: %s",
    async (text) => {
      const source = chunk(text, "nonclinical");
      const { result, generationInput } = await run(source);
      expect(generationInput.sources[0].purposeEligible).toBe(false);
      expect(result.claims).toHaveLength(0);
      expect(result.quiz).toHaveLength(0);
    },
  );
  it("still requires independent own-quote review for an unrecorded treatment claim", async () => {
    const { result, reviewInput } = await run(
      clinical,
      (generation) => {
        generation.claims[0].text = "用於治療合成症狀甲與未記載的合成症狀乙。";
      },
      false,
    );
    const checked = reviewInput.claims.find(
      (c: any) => c.checkType === "content",
    );
    expect(checked.text).toContain("未記載");
    expect(checked.citations[0].quote).not.toContain("症狀乙");
    expect(result.claims).toHaveLength(2);
    expect(
      result.claims.every((claim) => claim.kind?.startsWith("source_exact_")),
    ).toBe(true);
    expect(result.claims.some((claim) => claim.text.includes("症狀乙"))).toBe(
      false,
    );
    expect(result.quiz.filter((q) => q.id.startsWith("q"))).toEqual([]);
    expect(
      result.quiz.every((q) =>
        q.citations.every((citation) => clinical.text.includes(citation.quote)),
      ),
    ).toBe(true);
  });
  it("ends an old parent exception at a new 效能/附記 boundary", () => {
    const source = chunk(
      "警語：\n三、除非有醫師指示，請遵循下列情況使用：\n(一)合成風險者請勿自行使用。\n效能：用於治療合成症狀甲。\n附記：\n(一)對本品過敏者不可使用。",
      "parent-scope",
    );
    const note = sourcePassages([source]).find(
      (s) => s.sourceSection === "附記",
    )!;
    expect(note.quote).toContain("對本品過敏者不可使用");
    expect(note.requiredConditions).toEqual([]);
  });
  it("retains a literal 使用上注意事項 label and its condition metadata", () => {
    const source = chunk(
      "【使用上注意事項】除非有醫師指示，有合成風險者請勿自行使用。",
      "actual-warning-label",
    );
    const passage = sourcePassages([source])[0];
    expect(passage.sourceSection).toBe("使用上注意事項");
    expect(passage.requiredConditions).toEqual(["除非有醫師指示"]);
  });
});
