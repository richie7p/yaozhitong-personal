import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grounded, sourcePassages, type Llm } from "../server/ai";
import type { Chunk } from "../shared/schema";

const frozen = JSON.parse(
  readFileSync(
    new URL("./fixtures/source-integrity/014025.json", import.meta.url),
    "utf8",
  ),
);
const original: Chunk = {
  id: "kentamin-current-source",
  licenseNo: frozen.licenseNo,
  version: frozen.version,
  page: 1,
  start: 0,
  text: frozen.text,
  sourceFormat: "html",
};
const question =
  "請依仿單說明這款藥品用途和注意事項，逐項附原文依據。照片代碼130不代表含量，請勿推算個人劑量。";
function reviewer({ rejectPurpose = true, status = "supported" } = {}): Llm {
  return {
    json: async (system, input: any) => {
      if (system.includes("審核器"))
        return {
          verdicts: input.claims.map((c: any) => ({
            id: c.id,
            supported: !rejectPurpose || c.category !== "purpose",
          })),
        };
      if (status !== "supported")
        return { status, claims: [], quiz: [], followups: [] };
      const purpose = input.sources.find((s: any) => s.purposeEligible);
      const warning = input.sources.find(
        (s: any) =>
          s.sourceSection === "警語及注意事項" || s.sourceSection === "警語",
      );
      return {
        status,
        claims: [
          ...(purpose
            ? [
                {
                  text: purpose.text,
                  category: "purpose",
                  citations: [{ sourceId: purpose.id }],
                },
              ]
            : []),
          ...(warning
            ? [
                {
                  text: warning.text,
                  category: "warning",
                  citations: [{ sourceId: warning.id }],
                },
              ]
            : []),
        ],
        quiz: [],
        followups: [],
      };
    },
  };
}
describe("requested chat purpose completeness after independent rejection", () => {
  it("recovers the actual full Kentamin indication after the auditor drops its generated purpose", async () => {
    const r = await grounded(reviewer(), question, [original], {}, "chat");
    const exact = r.claims.find((c) => c.kind === "source_exact_purpose")!;
    const field = sourcePassages([original])
      .filter((p) => p.sourceSection === "適應症")
      .map((p) => p.quote)
      .join("");
    expect(r.status).toBe("supported");
    expect(r.rejectedCount).toBe(1);
    expect(exact.text).toBe(field.trim());
    expect(exact.text).toContain("Bl、B6、Bl2");
    expect(exact.text).toContain("妊娠授乳期");
    expect(exact.citations).toEqual([{ chunkId: original.id, quote: field }]);
    expect(original.text).toContain(exact.citations[0].quote);
    expect(r.claims.some((c) => c.category === "warning")).toBe(true);
    expect(r.quiz).toEqual([]);
    expect(r.followups).toEqual([]);
  });
  it("keeps later adult and child restrictions in a complete, literal field", async () => {
    const source = {
      ...original,
      text: "【適應症】緩解合成症狀。僅限成人。兒童不可使用。\n【警語】合成條件者請勿使用。",
    };
    const r = await grounded(
      reviewer(),
      "請說明用途和警語",
      [source],
      {},
      "chat",
    );
    expect(r.claims.find((c) => c.kind === "source_exact_purpose")?.text).toBe(
      "【適應症】緩解合成症狀。僅限成人。兒童不可使用。",
    );
    expect(r.quiz).toEqual([]);
  });
  it("preserves an approved whole-field purpose without duplicating or replacing it", async () => {
    const source = {
      ...original,
      text: "【適應症】緩解合成症狀。\n【警語】合成條件者請勿使用。",
    };
    const r = await grounded(
      reviewer({ rejectPurpose: false }),
      "用途和注意事項",
      [source],
      {},
      "chat",
    );
    expect(r.claims.filter((c) => c.category === "purpose")).toHaveLength(1);
    expect(r.claims.some((c) => c.kind === "source_exact_purpose")).toBe(false);
  });
  it.each([
    "【作用機轉】用於促進合成受體活性。",
    "【效能】增加合成受體活性與吸收濃度。",
    "【包裝】合成包裝。",
  ])(
    "does not mark warnings alone complete when no clinical purpose is available: %s",
    async (text) => {
      const source = {
        ...original,
        text: text + "\n【警語】合成條件者請勿使用。",
      };
      const r = await grounded(
        reviewer(),
        "請說明用途和警語",
        [source],
        {},
        "chat",
      );
      expect(r.status).toBe("insufficient_data");
      expect(r.claims.some((c) => c.category === "purpose")).toBe(false);
    },
  );
  it.each(["refused", "not_found"])(
    "does not turn an explicit %s response into purpose advice",
    async (status) => {
      const r = await grounded(
        reviewer({ status }),
        "我能服用嗎？也說明用途。",
        [original],
        {},
        "chat",
      );
      expect(r.status).toBe(status);
      expect(r.claims).toEqual([]);
      expect(r.chunks).toEqual([]);
      expect(r.quiz).toEqual([]);
      expect(r.followups).toEqual([]);
    },
  );
  it.each([
    "請說明注意事項",
    "不要說明用途，只問警語",
    "我可以用這個藥嗎？另外說明用途",
  ])(
    "does not add indication text outside a general purpose request: %s",
    async (q) => {
      const r = await grounded(reviewer(), q, [original], {}, "chat");
      expect(r.claims.some((c) => c.category === "purpose")).toBe(false);
      expect(r.quiz).toEqual([]);
    },
  );
  it("does not borrow one product's purpose to complete a second product", async () => {
    const second = {
      ...original,
      id: "other-source",
      licenseNo: "衛署藥製字第030418號",
      text: "【警語】合成其他條件者請勿使用。",
    };
    const r = await grounded(
      reviewer(),
      "這兩款的用途和注意事項",
      [original, second],
      {},
      "chat",
    );
    expect(r.status).toBe("insufficient_data");
    expect(
      r.claims
        .filter((c) => c.kind === "source_exact_purpose")
        .every((c) =>
          c.citations.every((citation) => citation.chunkId === original.id),
        ),
    ).toBe(true);
  });
  it("does not let one complete field hide a second incomplete field of the same product", async () => {
    const source = {
      ...original,
      text: "【適應症】緩解合成症狀甲。\n【包裝】合成包裝。\n【適應症】緩解合成症狀乙但條件未完\n【警語】合成條件者請勿使用。",
    };
    const r = await grounded(
      reviewer(),
      "說明用途和警語",
      [source],
      {},
      "chat",
    );
    expect(r.status).toBe("insufficient_data");
    expect(r.claims.some((c) => c.kind === "source_exact_purpose")).toBe(true);
  });
  it.each([
    "【適應症】緩解合成症狀。" + "完整合成限制。".repeat(220),
    "【適應症】緩解合成症狀但條件尚未完整",
  ])(
    "does not truncate an overlong or unfinished canonical purpose",
    async (text) => {
      const r = await grounded(
        reviewer(),
        "請說明用途和警語",
        [{ ...original, text: text + "\n【警語】合成條件者請勿使用。" }],
        {},
        "chat",
      );
      expect(r.status).toBe("insufficient_data");
      expect(r.claims.some((c) => c.kind === "source_exact_purpose")).toBe(
        false,
      );
    },
  );
});
