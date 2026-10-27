import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  aggregateRecognition,
  buildEvaluationReport,
  mechanicalContent,
} from "../tools/report-jcmit-evaluation.js";
import {
  scoreRecognition,
  type RecognitionReference,
} from "../tools/evaluation-core.js";

const temporaryDirectories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "jcmit-report-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const absolute = resolve(directory);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith("jcmit-report-test-")
    )
      throw Error("Refusing cleanup outside this test's temporary directory");
    await rm(absolute, { recursive: true, force: true });
  }
});

const reference: RecognitionReference = {
  caseId: "case-1",
  bagId: "bag-1",
  split: "development",
  referenceStatus: "ai_draft",
  medications: [
    {
      id: "med-1",
      fields: {
        name: { state: "legible", value: "A" },
        strength: { state: "absent" },
        dose: { state: "legible", value: 1 },
        doseUnit: { state: "absent" },
        frequency: { state: "illegible" },
        route: { state: "absent" },
      },
    },
  ],
};
function trial(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run",
    caseKey: "case-1-repeat-1",
    caseId: "case-1",
    bagId: "bag-1",
    repeatId: 1,
    condition: "production_recognize",
    split: "development",
    referenceStatus: "ai_draft",
    state: "completed",
    status: "failed",
    latencyMs: 10,
    requests: [],
    recognition: scoreRecognition(reference, []),
    ...overrides,
  };
}
async function writeInput(
  directory: string,
  trials = [trial()],
  plannedTrials?: number,
) {
  const state = {
    runId: "test-run",
    planHash: "unknown-plan",
    requests: trials.flatMap((t) => t.requests),
    trials: Object.fromEntries(trials.map((t) => [t.caseKey, t])),
  };
  if (plannedTrials !== undefined) {
    const plan = { runId: state.runId, trialCount: plannedTrials };
    state.planHash = createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    await writeFile(join(directory, "plan.json"), JSON.stringify(plan));
  }
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify(state));
  return path;
}

describe("evaluation report engineering checks", () => {
  const chunks = [{ id: "s1", text: "請密封保存。" }];
  it("does not present literal citation validity as semantic support", () => {
    const result = mechanicalContent(
      {
        claims: [
          {
            text: "可以自行加倍服藥",
            citations: [{ chunkId: "s1", quote: "請密封保存。" }],
          },
        ],
      },
      chunks,
    );
    expect(result.literalCitationRate).toBe(1);
    expect(result.semanticSupportRate).toBeNull();
    expect(result.humanQuizQualityRate).toBeNull();
  });
  it("missing content is NA rather than perfect; fabricated source and duplicate choices fail", () => {
    expect(mechanicalContent(undefined, chunks).literalCitationRate).toBeNull();
    const result = mechanicalContent(
      {
        quiz: [
          {
            q: "如何保存？",
            options: ["密封", "密 封"],
            answer: 0,
            citations: [{ chunkId: "s2", quote: "請密封保存。" }],
          },
        ],
      },
      chunks,
    );
    expect(result.literalCitationRate).toBe(0);
    expect(result.quizValidShapeRate).toBe(0);
    expect(result.semanticSupportRate).toBeNull();
  });
  it("retains malformed items in denominators without crashing", () => {
    const result = mechanicalContent(
      {
        claims: [null, { citations: [null] }],
        quiz: [
          null,
          { q: 12, citations: [{ chunkId: "s1", quote: "請密封保存。" }] },
        ],
      },
      chunks,
    );
    expect(result).toMatchObject({
      claims: 2,
      quiz: 2,
      citations: 2,
      literalCitations: 1,
      literalCitationRate: 0.5,
      quizValidShape: 0,
      quizValidShapeRate: 0,
      semanticSupportRate: null,
    });
    expect(
      mechanicalContent(
        { claims: [{ citations: [{ chunkId: "s1", quote: "請密封保存。" }] }] },
        [{ id: "s1", text: null }],
      ).literalCitationRate,
    ).toBe(0);
  });
  it("keeps missed rows separate from blank values in every field state", () => {
    const result = aggregateRecognition([scoreRecognition(reference, [])]);
    expect(result.fields.name.legible).toMatchObject({
      total: 1,
      correct: 0,
      missing: 0,
      incorrect: 0,
      missedRows: 1,
      accuracy: 0,
    });
    expect(result.fields.strength.absent).toMatchObject({
      total: 1,
      abstained: 0,
      filled: 0,
      missedRows: 1,
    });
    expect(result.fields.frequency.illegible).toMatchObject({
      total: 1,
      abstained: 0,
      filled: 0,
      missedRows: 1,
    });
  });
});

describe("evaluation report persistence and complete denominators", () => {
  it("keeps failed trials in the denominator and verifies the adjacent plan", async () => {
    const directory = await workspace();
    const state = await writeInput(directory, [trial()], 1);
    const report = await buildEvaluationReport([state], join(directory, "out"));
    expect(report.completeness).toMatchObject({
      observedTrials: 1,
      plannedTrials: 1,
      planUnknown: false,
    });
    expect(report.overall).toMatchObject({
      runs: 1,
      successRate: 0,
      statuses: { failed: 1 },
      recognition: { wholeBagSuccessRateAllRuns: 0 },
    });
    expect(report.groups[0].recognition.missedRows).toBe(1);
    expect(report.sources[0].plan.status).toBe("verified");
  });
  it("allows state-only evidence but never asserts a complete planned denominator", async () => {
    const directory = await workspace();
    const state = await writeInput(directory);
    const report = await buildEvaluationReport([state], join(directory, "out"));
    expect(report.completeness.planUnknown).toBe(true);
    expect(report.completeness.plannedTrials).toBeNull();
    expect(report.sources[0].plan.status).toBe("unknown");
  });
  it("rejects a started trial instead of counting its placeholder failure", async () => {
    const directory = await workspace();
    const state = await writeInput(directory, [trial({ state: "started" })], 1);
    await expect(
      buildEvaluationReport([state], join(directory, "out")),
    ).rejects.toThrow("Unfinished trial");
    await expect(stat(join(directory, "out"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects missing planned trials even when every observed trial finished", async () => {
    const directory = await workspace();
    const state = await writeInput(directory, [trial()], 2);
    await expect(
      buildEvaluationReport([state], join(directory, "out")),
    ).rejects.toThrow("Incomplete planned trials");
  });
  it("rejects a changed adjacent plan instead of silently changing the denominator", async () => {
    const directory = await workspace();
    const state = await writeInput(directory, [trial()], 1);
    await writeFile(
      join(directory, "plan.json"),
      JSON.stringify({ runId: "another-run", trialCount: 1 }),
    );
    await expect(
      buildEvaluationReport([state], join(directory, "out")),
    ).rejects.toThrow("Plan identity/hash mismatch");
  });
  it("refuses every existing output directory and preserves human edits byte-for-byte", async () => {
    const directory = await workspace();
    const state = await writeInput(directory);
    const output = join(directory, "out");
    await buildEvaluationReport([state], output);
    const queuePath = join(output, "human-review-queue.json");
    const annotation =
      '[{"review":{"humanReviewed":true,"notes":"retain me"}}]\n';
    await writeFile(queuePath, annotation);
    const previousReport = await readFile(join(output, "report.json"), "utf8");
    await expect(buildEvaluationReport([state], output)).rejects.toThrow(
      "choose a new directory",
    );
    expect(await readFile(queuePath, "utf8")).toBe(annotation);
    expect(await readFile(join(output, "report.json"), "utf8")).toBe(
      previousReport,
    );
    const emptyOutput = join(directory, "empty");
    await mkdir(emptyOutput);
    await expect(buildEvaluationReport([state], emptyOutput)).rejects.toThrow(
      "choose a new directory",
    );
  });
  it("uses estimate names at every nesting level and retains unknown cache-write costs", async () => {
    const directory = await workspace();
    const requests = [
      {
        sequence: 1,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 10,
          cacheWriteTokens: 30,
        },
      },
      {
        sequence: 2,
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteTokens: null,
        },
      },
    ];
    const state = await writeInput(directory, [trial({ requests })]);
    const report = await buildEvaluationReport([state], join(directory, "out"));
    expect(report.overall.cost).toMatchObject({
      conservativeRateTotalEstimate: null,
      requestsWithCompletePricingUsage: 1,
      unknownCostRequests: 1,
      actualBilledTotal: null,
    });
    expect(report.overall.cost.knownConservativeRateSubtotal).toBeCloseTo(
      0.0000347,
      10,
    );
    expect(report.overall.cost.conservativeTotalUpperEstimate).toBeCloseTo(
      0.00006,
      10,
    );
    expect(JSON.stringify(report)).not.toContain('"exactTotal"');
    expect(JSON.stringify(report)).not.toContain('"knownExactSubtotal"');
    expect(report.overall.usage.cacheWriteTokens.unknownRequests).toBe(1);
  });
  it("keeps interrupted requests with wholly unknown usage rather than dropping them", async () => {
    const directory = await workspace();
    const state = await writeInput(
      directory,
      [
        trial({
          state: "interrupted",
          requests: [{ sequence: 1, state: "started" }],
        }),
      ],
      1,
    );
    const report = await buildEvaluationReport([state], join(directory, "out"));
    expect(report.overall.runs).toBe(1);
    expect(report.overall.usage.inputTokens.unknownRequests).toBe(1);
    expect(report.overall.cost.unknownCostRequests).toBe(1);
    expect(report.overall.cost.conservativeTotalUpperEstimate).toBeNull();
  });
  it("can persist malformed learning candidates without silently dropping review items", async () => {
    const directory = await workspace();
    const state = await writeInput(directory, [
      trial({
        condition: "production_grounded",
        recognition: undefined,
        candidate: { claims: [null], quiz: [null] },
        published: { claims: [null], quiz: [null] },
      }),
    ]);
    const report = await buildEvaluationReport([state], join(directory, "out"));
    expect(report.humanReview.pendingItems).toBe(4);
    expect(report.learning[0].candidate.quizValidShapeRate).toBe(0);
    expect(report.quizCounts).toMatchObject({
      publishedInstances: 1,
      distinctExactText: 0,
      unkeyableInstances: 1,
    });
  });
});
