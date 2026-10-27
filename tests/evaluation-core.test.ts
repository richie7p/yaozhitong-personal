import { describe, expect, it } from "vitest";
import {
  FIELDS,
  normalizeField,
  scoreRecognition,
  summarizeRuns,
  type EvaluationRun,
  type PredictionMedication,
  type RateCard,
  type RecognitionReference,
  type ReferenceMedication,
  type UsageRequest,
} from "../tools/evaluation-core";

function medication(id: string, name: string, dose = 1): ReferenceMedication {
  return {
    id,
    fields: {
      name: { state: "legible", value: name },
      strength: { state: "legible", value: "5mg" },
      dose: { state: "legible", value: dose },
      doseUnit: { state: "legible", value: "錠" },
      frequency: { state: "legible", value: "QD PC" },
      route: { state: "legible", value: "口服" },
    },
    expectedLicenseNo: `LICENSE-${id}`,
  };
}

function reference(
  medications: readonly ReferenceMedication[],
): RecognitionReference {
  return {
    caseId: "image-1",
    bagId: "bag-1",
    split: "test",
    referenceStatus: "ai_draft",
    medications,
  };
}

function prediction(expected: ReferenceMedication): PredictionMedication {
  return {
    fields: Object.fromEntries(
      FIELDS.map((field) => {
        const value = expected.fields[field];
        return [field, value.state === "legible" ? value.value : null];
      }),
    ),
    candidates: expected.expectedLicenseNo ? [expected.expectedLicenseNo] : [],
  };
}

function run(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    runId: "run-1",
    caseId: "case-1",
    bagId: "bag-1",
    split: "test",
    condition: "grounded",
    repeatId: 1,
    status: "succeeded",
    latencyMs: 100,
    referenceStatus: "ai_draft",
    requests: [],
    ...overrides,
  };
}

const rateCard: RateCard = {
  currency: "TEST",
  inputPerMillion: 1,
  outputPerMillion: 5,
  cachedInputPerMillion: 0.1,
  cacheWritePerMillion: 1.25,
};

describe("conservative evaluation normalization", () => {
  it("normalizes typography and explicit units without erasing dosage conditions", () => {
    expect(normalizeField("strength", " ５ 毫克 / ２ 毫升 ")).toBe("5mg/2ml");
    expect(normalizeField("dose", "０１.００")).toBe("1");
    expect(normalizeField("route", "內服")).toBe(
      normalizeField("route", "口服"),
    );
    expect(normalizeField("frequency", "BID PRN")).not.toBe(
      normalizeField("frequency", "BID"),
    );
    expect(normalizeField("strength", "5mg/2ml")).not.toBe(
      normalizeField("strength", "5mg"),
    );
    expect(normalizeField("strength", "0.005g")).not.toBe(
      normalizeField("strength", "5mg"),
    );
    expect(normalizeField("dose", "半錠")).not.toBe(
      normalizeField("dose", 0.5),
    );
  });

  it("preserves NA as literal text and does not turn unknowns into zero", () => {
    expect(normalizeField("name", "N/A")).toBe("n/a");
    expect(normalizeField("dose", 0)).toBe("0");
    expect(normalizeField("dose", null)).toBeNull();
    expect(normalizeField("frequency", " ")).toBeNull();
    expect(() => normalizeField("dose", NaN)).toThrow("Non-finite");
  });
});

describe("one-to-one medication recognition scoring", () => {
  it("matches reordered rows globally and preserves draft reference provenance", () => {
    const first = medication("a", "合成甲");
    const second = medication("b", "合成乙", 2);
    const source = reference([first, second]);
    const predicted = [prediction(second), prediction(first)];
    const snapshot = JSON.stringify({ source, predicted });
    const result = scoreRecognition(source, predicted);
    expect(result.matches).toEqual([
      { referenceId: "a", predictionIndex: 1 },
      { referenceId: "b", predictionIndex: 0 },
    ]);
    expect(result.wholeBag).toBe(true);
    expect(result.top1).toEqual({ correct: 2, total: 2, rate: 1 });
    expect(result.humanValidated).toBe(false);
    expect(result.referenceStatus).toBe("ai_draft");
    expect(JSON.stringify({ source, predicted })).toBe(snapshot);
  });

  it("does not reuse one predicted row for two references with identical names", () => {
    const first = medication("a", "同名藥", 1);
    const second = medication("b", "同名藥", 2);
    const result = scoreRecognition(reference([first, second]), [
      prediction(second),
    ]);
    expect(result.matchedRows).toBe(1);
    expect(result.missedRows).toBe(1);
    expect(result.extraRows).toBe(0);
    expect(result.matches[1].predictionIndex).toBe(0);
    expect(result.fields.dose.legible).toMatchObject({
      total: 2,
      correct: 1,
      missedRows: 1,
      accuracy: 0.5,
    });
    expect(result.wholeBag).toBe(false);
  });

  it("counts duplicate hallucinated rows and refuses candidate-based identity matching", () => {
    const expected = medication("a", "合成甲");
    const duplicate = scoreRecognition(reference([expected]), [
      prediction(expected),
      prediction(expected),
    ]);
    expect(duplicate.extraRows).toBe(1);
    expect(duplicate.wholeBag).toBe(false);
    const wrongName = scoreRecognition(reference([expected]), [
      {
        ...prediction(expected),
        fields: { ...prediction(expected).fields, name: "另一藥" },
      },
    ]);
    expect(wrongName.matchedRows).toBe(0);
    expect(wrongName.extraRows).toBe(1);
    expect(wrongName.top1.rate).toBe(0);
  });

  it("keeps absent and illegible denominators separate and never rewards omitted medication rows", () => {
    const expected = medication("a", "合成甲");
    expected.fields = {
      ...expected.fields,
      dose: { state: "absent" },
      frequency: { state: "illegible" },
    };
    const result = scoreRecognition(reference([expected]), [
      {
        ...prediction(expected),
        fields: { ...prediction(expected).fields, dose: 1, frequency: null },
      },
    ]);
    expect(result.fields.dose.legible.accuracy).toBeNull();
    expect(result.fields.dose.absent).toEqual({
      total: 1,
      abstained: 0,
      filled: 1,
      missedRows: 0,
      abstentionRate: 0,
    });
    expect(result.fields.frequency.illegible.abstentionRate).toBe(1);
    expect(result.wholeBag).toBe(false);
    const missed = scoreRecognition(reference([expected]), []);
    expect(missed.fields.dose.absent.abstained).toBe(0);
    expect(missed.fields.dose.absent.missedRows).toBe(1);
  });

  it("reports omitted legible fields and top-3 separately, without empty-denominator success", () => {
    const expected = medication("a", "合成甲");
    const result = scoreRecognition(reference([expected]), [
      {
        fields: { ...prediction(expected).fields, dose: null },
        candidates: ["WRONG", "LICENSE-a"],
      },
    ]);
    expect(result.fields.dose.legible.missing).toBe(1);
    expect(result.fields.dose.legible.accuracy).toBe(0);
    expect(result.top1.rate).toBe(0);
    expect(result.top3.rate).toBe(1);
    const noGoldLicense = { ...expected, expectedLicenseNo: null };
    expect(
      scoreRecognition(reference([noGoldLicense]), [prediction(noGoldLicense)])
        .top1.rate,
    ).toBeNull();
    const empty = scoreRecognition(reference([]), []);
    expect(empty.fields.name.legible.accuracy).toBeNull();
    expect(empty.top1.rate).toBeNull();
    expect(empty.wholeBag).toBe(true);
  });

  it("does not claim whole-bag exactness when the reference identity is unreadable", () => {
    const expected = medication("a", "合成甲");
    expected.fields = { ...expected.fields, name: { state: "illegible" } };
    const result = scoreRecognition(reference([expected]), []);
    expect(result.unmatchableReferenceRows).toBe(1);
    expect(result.wholeBag).toBeNull();
  });

  it("accepts only predeclared aliases and rejects malformed gold references", () => {
    const expected = medication("a", "合成甲");
    expected.fields = {
      ...expected.fields,
      name: { state: "legible", value: "合成甲", alternatives: ["Fixture A"] },
    };
    expect(
      scoreRecognition(reference([expected]), [
        {
          fields: { ...prediction(expected).fields, name: "Ｆｉｘｔｕｒｅ A" },
        },
      ]).matchedRows,
    ).toBe(1);
    expect(() => scoreRecognition(reference([expected, expected]), [])).toThrow(
      "Duplicate reference row",
    );
    expected.fields = {
      ...expected.fields,
      dose: { state: "legible", value: "" },
    };
    expect(() => scoreRecognition(reference([expected]), [])).toThrow(
      "Empty legible",
    );
  });
});

describe("research run aggregation", () => {
  it("separates bags, cases, repeats, conditions and failures without mutating inputs", () => {
    const runs = [
      run({ latencyMs: 100 }),
      run({ runId: "run-2", repeatId: 2, latencyMs: 300, status: "failed" }),
      run({ runId: "run-3", condition: "direct", latencyMs: 200 }),
      run({
        runId: "run-4",
        caseId: "case-2",
        bagId: "bag-2",
        split: "development",
        latencyMs: null,
        status: "partial",
      }),
    ];
    const snapshot = JSON.stringify(runs);
    const result = summarizeRuns(runs);
    expect(result.runs).toBe(4);
    expect(result.uniqueBags).toBe(2);
    expect(result.uniqueCases).toBe(2);
    expect(result.uniqueCaseRepeats).toBe(3);
    expect(result.additionalRepeatRuns).toBe(1);
    expect(result.repeatIds).toEqual([1, 2]);
    expect(result.successRate).toBe(0.5);
    expect(result.groups).toHaveLength(3);
    expect(result.latency.all).toEqual({
      known: 3,
      unknown: 1,
      p50Ms: 200,
      p95Ms: 300,
      maximumMs: 300,
      method: "nearest_rank",
    });
    expect(result.latency.succeeded.p50Ms).toBe(100);
    expect(result.latency.unsuccessful.p50Ms).toBe(300);
    expect(JSON.stringify(runs)).toBe(snapshot);
  });

  it("rejects duplicate IDs, repeated observations and bag-level split leakage", () => {
    expect(() => summarizeRuns([run(), run()])).toThrow("Duplicate runId");
    expect(() => summarizeRuns([run(), run({ runId: "another" })])).toThrow(
      "Duplicate case/condition/repeat",
    );
    expect(() =>
      summarizeRuns([
        run(),
        run({
          runId: "other",
          caseId: "cropped-copy",
          split: "development",
        }),
      ]),
    ).toThrow("Bag split leakage");
    expect(() =>
      summarizeRuns([
        run(),
        run({ runId: "other", bagId: "other-bag", repeatId: 2 }),
      ]),
    ).toThrow("Case changes bag identity");
  });

  it("uses nearest-rank for even and small samples and exposes NA for no observations", () => {
    const result = summarizeRuns([
      run({ latencyMs: 10 }),
      run({ runId: "two", repeatId: 2, latencyMs: 20 }),
      run({ runId: "three", repeatId: 3, latencyMs: 30 }),
      run({ runId: "four", repeatId: 4, latencyMs: 40 }),
    ]);
    expect(result.latency.all.p50Ms).toBe(20);
    expect(result.latency.all.p95Ms).toBe(40);
    expect(summarizeRuns([]).successRate).toBeNull();
    expect(summarizeRuns([]).latency.all.p50Ms).toBeNull();
    expect(summarizeRuns([]).recognition.wholeBagRate).toBeNull();
  });

  it("prices cache writes as a subset, retains unknown usage and provides only a conservative upper estimate", () => {
    const known = run({
      requests: [
        {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cachedInputTokens: 200_000,
          cacheWriteTokens: 300_000,
        },
      ],
    });
    const exact = summarizeRuns([known], rateCard);
    expect(exact.cost.exactTotal).toBeCloseTo(0.5 + 0.02 + 0.375 + 0.5);
    const unknownWrite = run({
      requests: [{ ...known.requests![0], cacheWriteTokens: null }],
    });
    const result = summarizeRuns([unknownWrite], rateCard);
    expect(result.cost.exactTotal).toBeNull();
    expect(result.cost.exactRequests).toBe(0);
    expect(result.usage.cacheWriteTokens).toEqual({
      knownTotal: 0,
      knownRequests: 0,
      unknownRequests: 1,
      complete: false,
    });
    expect(result.cost.conservativeTotalUpperEstimate).toBe(1.75);
    expect(result.usage.inputTokens.complete).toBe(true);
  });

  it("does not hide failed-request missing usage behind a partial known subtotal", () => {
    const result = summarizeRuns(
      [
        run({
          status: "failed",
          requests: [
            {
              inputTokens: 100,
              outputTokens: 10,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
            },
            {
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              cacheWriteTokens: null,
            },
          ],
        }),
      ],
      rateCard,
    );
    expect(result.usage.inputTokens.knownTotal).toBe(100);
    expect(result.usage.inputTokens.complete).toBe(false);
    expect(result.cost.exactTotal).toBeNull();
    expect(result.cost.knownExactSubtotal).toBeGreaterThan(0);
    expect(result.cost.conservativeTotalUpperEstimate).toBeNull();
    const missing = summarizeRuns([run({ requests: undefined })], rateCard);
    expect(missing.usage.runsWithUnknownRequests).toBe(1);
    expect(missing.cost.exactTotal).toBeNull();
    expect(missing.cost.conservativeTotalUpperEstimate).toBeNull();
    expect(summarizeRuns([run()]).cost.exactTotal).toBeNull();
    const omittedJsonFields = summarizeRuns(
      [
        run({
          requests: [{ inputTokens: 100, outputTokens: 1 } as UsageRequest],
        }),
      ],
      rateCard,
    );
    expect(omittedJsonFields.cost.exactTotal).toBeNull();
    expect(omittedJsonFields.usage.cacheWriteTokens.unknownRequests).toBe(1);
    expect(
      omittedJsonFields.cost.conservativeTotalUpperEstimate,
    ).toBeGreaterThan(0);
  });

  it("keeps unscored failed attempts visible in end-to-end recognition success", () => {
    const score = scoreRecognition(reference([]), []);
    const result = summarizeRuns([
      run({ caseId: score.caseId, recognition: score }),
      run({
        runId: "failed-repeat",
        caseId: score.caseId,
        repeatId: 2,
        status: "failed",
      }),
    ]);
    expect(result.recognition.scoredRuns).toBe(1);
    expect(result.recognition.unscoredRuns).toBe(1);
    expect(result.recognition.wholeBagRate).toBe(1);
    expect(result.recognition.wholeBagSuccessRateAllRuns).toBe(0.5);
  });

  it("rejects impossible usage, invalid repeats and false human-validation provenance", () => {
    expect(() => summarizeRuns([run({ repeatId: 0 })])).toThrow("repeatId");
    expect(() => summarizeRuns([run({ latencyMs: -1 })])).toThrow("latencyMs");
    expect(() =>
      summarizeRuns([
        run({
          requests: [
            {
              inputTokens: 10,
              outputTokens: 1,
              cachedInputTokens: 9,
              cacheWriteTokens: 8,
            },
          ],
        }),
      ]),
    ).toThrow("Cache subsets");
    const score = scoreRecognition(reference([]), []);
    expect(() =>
      summarizeRuns([
        run({
          caseId: score.caseId,
          recognition: { ...score, humanValidated: true },
        }),
      ]),
    ).toThrow("provenance mismatch");
  });
});
