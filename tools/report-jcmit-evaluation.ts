import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FIELDS,
  summarizeRuns,
  type EvaluationRun,
  type RateCard,
  type RecognitionScore,
  type RunGroupSummary,
} from "./evaluation-core.js";

type RecordValue = Record<string, any>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ratio = (n: number, d: number) => (d ? n / d : null);
const normalized = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const arrayItems = (value: unknown): RecordValue[] =>
  Array.isArray(value) ? value : [];
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};

/** The supplied long-context rate card is a planning estimate, not a bill. */
function reportGroup<T extends RunGroupSummary>(summary: T) {
  const { cost, ...rest } = summary;
  const { exactTotal, knownExactSubtotal, exactRequests, ...estimates } = cost;
  return {
    ...rest,
    cost: {
      ...estimates,
      conservativeRateTotalEstimate: exactTotal,
      knownConservativeRateSubtotal: knownExactSubtotal,
      requestsWithCompletePricingUsage: exactRequests,
      actualBilledTotal: null,
      classification: "conservative_rate_estimate_not_invoice" as const,
    },
  };
}

function reportRuns(runs: EvaluationRun[], rateCard: RateCard) {
  const { groups, ...summary } = summarizeRuns(runs, rateCard);
  return { ...reportGroup(summary), groups: groups.map(reportGroup) };
}

/** Only literal containment and shape, never semantic support or clinical validity. */
export function mechanicalContent(
  output: RecordValue | null | undefined,
  chunks: RecordValue[],
) {
  const claims: RecordValue[] = Array.isArray(output?.claims)
    ? output.claims
    : [];
  const quiz: RecordValue[] = Array.isArray(output?.quiz) ? output.quiz : [];
  const citations = [...claims, ...quiz].flatMap((item) =>
    Array.isArray(item?.citations) ? item.citations : [],
  );
  const literal = citations.filter(
    (c) =>
      typeof c?.quote === "string" &&
      c.quote.trim() &&
      chunks.some(
        (s) =>
          s?.id === c.chunkId &&
          typeof s?.text === "string" &&
          normalized(s.text).includes(normalized(c.quote)),
      ),
  ).length;
  const validShape = quiz.filter(
    (q) =>
      typeof q?.q === "string" &&
      q.q.trim() &&
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      q.options.every((o: unknown) => typeof o === "string" && o.trim()) &&
      new Set(q.options.map(normalized)).size === q.options.length &&
      Number.isInteger(q.answer) &&
      q.answer >= 0 &&
      q.answer < q.options.length,
  ).length;
  return {
    claims: claims.length,
    quiz: quiz.length,
    citations: citations.length,
    literalCitations: literal,
    literalCitationRate: ratio(literal, citations.length),
    quizValidShape: validShape,
    quizValidShapeRate: ratio(validShape, quiz.length),
    semanticSupportRate: null,
    humanQuizQualityRate: null,
    note: "Literal containment/format are engineering checks, not human semantic correctness.",
  };
}

export function aggregateRecognition(scores: RecognitionScore[]) {
  return {
    scoredRuns: scores.length,
    referenceRows: scores.reduce((s, r) => s + r.referenceRows, 0),
    matchedRows: scores.reduce((s, r) => s + r.matchedRows, 0),
    predictedRows: scores.reduce((s, r) => s + r.predictedRows, 0),
    missedRows: scores.reduce((s, r) => s + r.missedRows, 0),
    extraRows: scores.reduce((s, r) => s + r.extraRows, 0),
    fields: Object.fromEntries(
      FIELDS.map((field) => {
        const sum = (state: "legible" | "absent" | "illegible", key: string) =>
          scores.reduce(
            (s, r) => s + Number((r.fields[field][state] as any)[key] || 0),
            0,
          );
        const legible = {
          total: sum("legible", "total"),
          correct: sum("legible", "correct"),
          missing: sum("legible", "missing"),
          incorrect: sum("legible", "incorrect"),
          missedRows: sum("legible", "missedRows"),
        };
        const blank = (state: "absent" | "illegible") => {
          const total = sum(state, "total"),
            filled = sum(state, "filled"),
            abstained = sum(state, "abstained");
          return {
            total,
            filled,
            abstained,
            missedRows: sum(state, "missedRows"),
            filledRate: ratio(filled, total),
          };
        };
        return [
          field,
          {
            legible: {
              ...legible,
              accuracy: ratio(legible.correct, legible.total),
            },
            absent: blank("absent"),
            illegible: blank("illegible"),
          },
        ];
      }),
    ),
    top1: {
      correct: scores.reduce((s, r) => s + r.top1.correct, 0),
      total: scores.reduce((s, r) => s + r.top1.total, 0),
    },
    top3: {
      correct: scores.reduce((s, r) => s + r.top3.correct, 0),
      total: scores.reduce((s, r) => s + r.top3.total, 0),
    },
  };
}

export async function buildEvaluationReport(
  statePaths: string[],
  outputDirectory: string,
) {
  if (!statePaths.length) throw Error("At least one state file is required");
  const inputs = await Promise.all(
    statePaths.map(async (path) => {
      const bytes = await readFile(path);
      const state = JSON.parse(bytes.toString()) as RecordValue;
      const observedTrials = Object.values(state.trials) as RecordValue[];
      if (
        observedTrials.some(
          (t) => t.state !== "completed" && t.state !== "interrupted",
        )
      )
        throw Error("Unfinished trial; refuse to publish a partial snapshot");
      const planPath = join(dirname(path), "plan.json");
      let planBytes: Buffer | undefined;
      try {
        planBytes = await readFile(planPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let planEvidence:
        | {
            status: "verified";
            path: string;
            sha256: string;
            plannedTrials: number;
          }
        | { status: "unknown"; plannedTrials: null };
      if (planBytes) {
        const plan = JSON.parse(planBytes.toString()) as RecordValue;
        if (
          plan.runId !== state.runId ||
          hash(canonical(plan)) !== state.planHash
        )
          throw Error("Plan identity/hash mismatch");
        if (
          !Number.isInteger(plan.trialCount) ||
          plan.trialCount < 0 ||
          observedTrials.length !== plan.trialCount
        )
          throw Error(
            "Incomplete planned trials; refuse to omit a denominator",
          );
        planEvidence = {
          status: "verified",
          path: planPath,
          sha256: hash(planBytes.toString()),
          plannedTrials: plan.trialCount,
        };
      } else {
        planEvidence = { status: "unknown", plannedTrials: null };
      }
      return {
        path,
        sha256: hash(bytes.toString()),
        state,
        planEvidence,
      };
    }),
  );
  const trials: RecordValue[] = inputs.flatMap(
    (i) => Object.values(i.state.trials) as RecordValue[],
  );
  if (new Set(trials.map((t) => t.caseKey)).size !== trials.length)
    throw Error("Duplicate caseKey");
  for (const { state } of inputs) {
    const sequences = (Object.values(state.trials) as RecordValue[]).flatMap(
      (t) => t.requests.map((r: RecordValue) => r.sequence),
    );
    if (
      sequences.length !== state.requests.length ||
      new Set(sequences).size !== sequences.length ||
      state.requests.some((r: RecordValue) => !sequences.includes(r.sequence))
    )
      throw Error(
        "HTTP ledger mismatch; refuse to double-count or omit requests",
      );
  }
  const runs: EvaluationRun[] = trials.map((t) => ({
    runId: t.caseKey,
    caseId: t.caseId,
    bagId: t.bagId,
    split: t.split,
    condition: t.condition,
    repeatId: t.repeatId,
    status: t.status,
    latencyMs: t.latencyMs,
    referenceStatus: t.referenceStatus,
    recognition: t.recognition,
    requests: t.requests.map(
      (r: RecordValue) =>
        r.usage ?? {
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          cacheWriteTokens: null,
        },
    ),
  }));
  // The runner uses conservative long-context rates. Keep the same policy here.
  const rateCard = {
    currency: "USD",
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    cacheWritePerMillion: 0.25,
    outputPerMillion: 0.75,
  };
  const groups = [
    ...new Set(trials.map((t) => `${t.condition}:${t.split}`)),
  ].map((key) => {
    const rows = trials.filter((t) => `${t.condition}:${t.split}` === key);
    return {
      key,
      all: reportRuns(
        runs.filter((r) => `${r.condition}:${r.split}` === key),
        rateCard,
      ),
      firstRepeat: reportRuns(
        runs.filter(
          (r) => `${r.condition}:${r.split}` === key && r.repeatId === 1,
        ),
        rateCard,
      ),
      recognition: aggregateRecognition(
        rows.flatMap((t) => (t.recognition ? [t.recognition] : [])),
      ),
      firstRepeatRecognition: aggregateRecognition(
        rows.flatMap((t) =>
          t.repeatId === 1 && t.recognition ? [t.recognition] : [],
        ),
      ),
    };
  });
  const learning = trials
    .filter((t) => t.condition === "production_grounded")
    .map((t) => ({
      caseKey: t.caseKey,
      caseId: t.caseId,
      sourceGroupId: t.bagId,
      repeatId: t.repeatId,
      status: t.status,
      candidate: mechanicalContent(t.candidate, arrayItems(t.sourceChunks)),
      published: mechanicalContent(t.published, arrayItems(t.sourceChunks)),
      rejectedCount: t.published?.rejectedCount ?? null,
      safetyCoverage: t.published?.safetyCoverage ?? null,
      contentOrigins: arrayItems(t.published?.claims).map(
        (c: RecordValue) => c?.kind ?? "unspecified",
      ),
    }));
  const allQuiz = trials.flatMap((t) => arrayItems(t.published?.quiz));
  const quizTextKeys = allQuiz
    .filter(
      (q) =>
        typeof q?.q === "string" &&
        Array.isArray(q.options) &&
        Number.isInteger(q.answer),
    )
    .map((q) => hash(JSON.stringify([q.q, q.options, q.answer])));
  const reviewKey: RecordValue[] = [];
  const reviewQueue: RecordValue[] = [];
  for (const t of trials.filter((t) => t.condition === "production_grounded")) {
    for (const condition of ["candidate", "published"] as const) {
      for (const kind of ["claims", "quiz"] as const) {
        for (const [index, content] of arrayItems(
          t[condition]?.[kind],
        ).entries()) {
          const itemId = hash(
            JSON.stringify([t.caseKey, condition, kind, index]),
          ).slice(0, 20);
          reviewQueue.push({
            itemId,
            kind,
            content,
            sourceChunks: arrayItems(t.sourceChunks),
            review: {
              reviewerId: null,
              reviewerRole: null,
              humanReviewed: false,
              sourceSupported: null,
              conditionsPreserved: null,
              uniqueAnswer: null,
              allOptionsJudgeable: null,
              explanationSupported: null,
              notes: null,
            },
          });
          reviewKey.push({
            itemId,
            runId: t.runId,
            caseId: t.caseId,
            repeatId: t.repeatId,
            condition,
            kind,
            index,
          });
        }
      }
    }
  }
  reviewQueue.sort((a, b) => a.itemId.localeCompare(b.itemId));
  const summary = {
    generatedAt: new Date().toISOString(),
    sources: inputs.map(({ path, sha256, planEvidence }) => ({
      path,
      sha256,
      plan: planEvidence,
    })),
    completeness: {
      observedTrials: trials.length,
      plannedTrials: inputs.every((i) => i.planEvidence.status === "verified")
        ? inputs.reduce((sum, i) => sum + i.planEvidence.plannedTrials!, 0)
        : null,
      planUnknown: inputs.some((i) => i.planEvidence.status === "unknown"),
      note: "Only completed/interrupted trials are accepted. Missing plans leave the full planned denominator unknown.",
    },
    costPolicy: {
      rateCard,
      description:
        "Conservative long-context Standard Luna estimate at official 2026-10-20 rates; not invoice; cache-write unknown stays unknown.",
      source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
    },
    overall: reportRuns(runs, rateCard),
    groups,
    learning,
    quizCounts: {
      publishedInstances: allQuiz.length,
      distinctExactText: new Set(quizTextKeys).size,
      unkeyableInstances: allQuiz.length - quizTextKeys.length,
      definition:
        "Exact q/options/answer only; not distinct learning objectives.",
    },
    humanReview: {
      completed: 0,
      pendingItems: reviewQueue.length,
      semanticResults: null,
    },
    failures: trials
      .filter(
        (t) => t.status !== "succeeded" || t.recognition?.wholeBag === false,
      )
      .map((t) => ({
        runId: t.runId,
        caseId: t.caseId,
        repeatId: t.repeatId,
        status: t.status,
        error: t.error ?? null,
        wholeBag: t.recognition?.wholeBag ?? null,
      })),
  };
  await mkdir(dirname(outputDirectory), { recursive: true });
  try {
    // Atomic directory creation reserves this output for one report writer.
    // Even an empty existing directory must be replaced by a new destination.
    await mkdir(outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Error(
        "Report output already exists; choose a new directory to preserve reports and human reviews",
      );
    throw error;
  }
  for (const [name, value] of Object.entries({
    "report.json": summary,
    "human-review-queue.json": reviewQueue,
    "human-review-key.json": reviewKey,
  }))
    await writeFile(
      join(outputDirectory, name),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [output, ...states] = process.argv.slice(2);
  if (!output || !states.length)
    throw Error(
      "Usage: report-jcmit-evaluation.ts OUTPUT_DIRECTORY STATE_JSON...",
    );
  const report = await buildEvaluationReport(
    states.map((path) => resolve(path)),
    resolve(output),
  );
  console.log(
    JSON.stringify({
      report: join(resolve(output), "report.json"),
      runs: report.overall.runs,
      requests: report.overall.usage.requests,
      costUpperUsd: report.overall.cost.conservativeTotalUpperEstimate,
      humanReviewPending: report.humanReview.pendingItems,
    }),
  );
}
