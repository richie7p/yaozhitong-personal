export const FIELDS = [
  "name",
  "strength",
  "dose",
  "doseUnit",
  "frequency",
  "route",
] as const;

export type Field = (typeof FIELDS)[number];
export type FieldValue = string | number | null | undefined;
export type Split = "development" | "test";
export type ReferenceStatus = "ai_draft" | "human_reviewed" | "adjudicated";
export type ReferenceField =
  | {
      state: "legible";
      value: string | number;
      alternatives?: readonly (string | number)[];
    }
  | { state: "absent" | "illegible" };

export interface ReferenceMedication {
  id: string;
  fields: Readonly<Record<Field, ReferenceField>>;
  expectedLicenseNo?: string | null;
}

export interface RecognitionReference {
  caseId: string;
  bagId: string;
  split: Split;
  referenceStatus: ReferenceStatus;
  medications: readonly ReferenceMedication[];
}

export interface PredictionMedication {
  fields: Readonly<Partial<Record<Field, FieldValue>>>;
  candidates?: readonly string[];
}

/** Typography only, plus explicit unit/route synonyms. No dose inference or conversion. */
export function normalizeField(field: Field, value: FieldValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value))
    throw Error("Non-finite field value");
  let text = String(value).normalize("NFKC").trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/\s+/g, " ");
  if (field === "strength") {
    text = text
      .replace(/微克|μg|µg/g, "mcg")
      .replace(/毫克|公絲/g, "mg")
      .replace(/毫升/g, "ml")
      .replace(/公克/g, "g")
      .replace(/\s*(mg|mcg|ml|g|iu|%|\/|\+)\s*/g, "$1");
  }
  if (field === "dose" && /^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    // Decimal presentation is normalized without converting fractions or units.
    const numeric = Number(text);
    if (Number.isFinite(numeric)) text = String(numeric);
  }
  if (field === "doseUnit") {
    const units: Readonly<Record<string, string>> = {
      毫克: "mg",
      公絲: "mg",
      微克: "mcg",
      毫升: "ml",
      公克: "g",
    };
    text = units[text] ?? text;
  }
  if (field === "route") {
    const routes: Readonly<Record<string, string>> = {
      口服: "oral",
      內服: "oral",
      oral: "oral",
    };
    text = routes[text] ?? text;
  }
  return text;
}

interface LegibleScore {
  total: number;
  correct: number;
  incorrect: number;
  missing: number;
  missedRows: number;
  accuracy: number | null;
}

interface BlankScore {
  total: number;
  abstained: number;
  filled: number;
  missedRows: number;
  abstentionRate: number | null;
}

export interface FieldScore {
  legible: LegibleScore;
  absent: BlankScore;
  illegible: BlankScore;
}

export interface RecognitionScore {
  caseId: string;
  bagId: string;
  split: Split;
  referenceStatus: ReferenceStatus;
  humanValidated: boolean;
  matchingPolicy: "exact_name_maximum_field_agreement_v1";
  referenceRows: number;
  predictedRows: number;
  matchedRows: number;
  missedRows: number;
  extraRows: number;
  unmatchableReferenceRows: number;
  matches: readonly {
    referenceId: string;
    predictionIndex: number | null;
  }[];
  fields: Readonly<Record<Field, FieldScore>>;
  top1: { correct: number; total: number; rate: number | null };
  top3: { correct: number; total: number; rate: number | null };
  wholeBag: boolean | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function expectedValues(field: Field, reference: ReferenceField): string[] {
  if (reference.state !== "legible") return [];
  return [reference.value, ...(reference.alternatives ?? [])].map((value) => {
    const normalized = normalizeField(field, value);
    if (normalized === null) throw Error(`Empty legible reference: ${field}`);
    return normalized;
  });
}

function agrees(
  field: Field,
  reference: ReferenceField,
  predicted: FieldValue,
): boolean {
  const normalized = normalizeField(field, predicted);
  return reference.state === "legible"
    ? normalized !== null &&
        expectedValues(field, reference).includes(normalized)
    : normalized === null;
}

/** Rectangular maximum-weight assignment; private dummy columns permit unmatched rows. */
function maximumAssignment(weights: readonly (readonly number[])[]): number[] {
  const rowCount = weights.length;
  if (!rowCount) return [];
  const predictionCount = weights[0]?.length ?? 0;
  const columns = predictionCount + rowCount;
  const u = Array<number>(rowCount + 1).fill(0);
  const v = Array<number>(columns + 1).fill(0);
  const p = Array<number>(columns + 1).fill(0);
  const way = Array<number>(columns + 1).fill(0);
  for (let row = 1; row <= rowCount; row++) {
    p[0] = row;
    let column = 0;
    const minimum = Array<number>(columns + 1).fill(Infinity);
    const used = Array<boolean>(columns + 1).fill(false);
    do {
      used[column] = true;
      const activeRow = p[column];
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= columns; candidate++) {
        if (used[candidate]) continue;
        const weight =
          candidate <= predictionCount
            ? weights[activeRow - 1][candidate - 1]
            : 0;
        const reduced = -weight - u[activeRow] - v[candidate];
        if (reduced < minimum[candidate]) {
          minimum[candidate] = reduced;
          way[candidate] = column;
        }
        if (minimum[candidate] < delta) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= columns; candidate++) {
        if (used[candidate]) {
          u[p[candidate]] += delta;
          v[candidate] -= delta;
        } else minimum[candidate] -= delta;
      }
      column = nextColumn;
    } while (p[column] !== 0);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column !== 0);
  }
  const assignment = Array<number>(rowCount).fill(-1);
  for (let column = 1; column <= predictionCount; column++) {
    const row = p[column];
    if (row && weights[row - 1][column - 1] > 0)
      assignment[row - 1] = column - 1;
  }
  return assignment;
}

function nonempty(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim())
    throw Error(`Missing ${name}`);
}

function validateReference(reference: RecognitionReference): void {
  nonempty(reference.caseId, "caseId");
  nonempty(reference.bagId, "bagId");
  validateSplit(reference.split);
  validateReferenceStatus(reference.referenceStatus);
  const ids = new Set<string>();
  for (const row of reference.medications) {
    nonempty(row.id, "reference medication id");
    if (ids.has(row.id)) throw Error(`Duplicate reference row: ${row.id}`);
    ids.add(row.id);
    for (const field of FIELDS) {
      const value = row.fields[field];
      if (!value || !["legible", "absent", "illegible"].includes(value.state))
        throw Error(`Missing reference field state: ${row.id}/${field}`);
      expectedValues(field, value);
    }
  }
}

function validateSplit(split: Split): void {
  if (split !== "development" && split !== "test")
    throw Error(`Invalid split: ${split}`);
}

function validateReferenceStatus(status: ReferenceStatus): void {
  if (!["ai_draft", "human_reviewed", "adjudicated"].includes(status))
    throw Error(`Invalid reference status: ${status}`);
}

/**
 * Matches only exact normalized names or predeclared name alternatives.
 * Duplicate names are assigned globally by field agreement, never by candidate license.
 * Missed rows do not earn abstention credit. An unreadable reference name makes
 * whole-bag exact scoring unavailable; field omissions remain separately visible.
 */
export function scoreRecognition(
  reference: RecognitionReference,
  predictions: readonly PredictionMedication[],
): RecognitionScore {
  validateReference(reference);
  const matchedRowPriority =
    (reference.medications.length + predictions.length) * FIELDS.length + 1;
  const weights = reference.medications.map((expected) =>
    predictions.map((prediction) => {
      if (
        expected.fields.name.state !== "legible" ||
        !agrees("name", expected.fields.name, prediction.fields.name)
      )
        return 0;
      return (
        matchedRowPriority +
        FIELDS.reduce(
          (total, field) =>
            total +
            Number(
              agrees(field, expected.fields[field], prediction.fields[field]),
            ),
          0,
        )
      );
    }),
  );
  const assignment = maximumAssignment(weights);
  const fields = Object.fromEntries(
    FIELDS.map((field) => [
      field,
      {
        legible: {
          total: 0,
          correct: 0,
          incorrect: 0,
          missing: 0,
          missedRows: 0,
          accuracy: null,
        },
        absent: {
          total: 0,
          abstained: 0,
          filled: 0,
          missedRows: 0,
          abstentionRate: null,
        },
        illegible: {
          total: 0,
          abstained: 0,
          filled: 0,
          missedRows: 0,
          abstentionRate: null,
        },
      } satisfies FieldScore,
    ]),
  ) as Record<Field, FieldScore>;
  let knownLicenses = 0;
  let top1Correct = 0;
  let top3Correct = 0;
  let everyFieldCorrect = true;
  for (let index = 0; index < reference.medications.length; index++) {
    const expected = reference.medications[index];
    const prediction = predictions[assignment[index]];
    for (const field of FIELDS) {
      const gold = expected.fields[field];
      const score = fields[field];
      const actual = normalizeField(field, prediction?.fields[field]);
      if (gold.state === "legible") {
        score.legible.total++;
        if (!prediction) score.legible.missedRows++;
        else if (actual === null) score.legible.missing++;
        else if (agrees(field, gold, actual)) score.legible.correct++;
        else score.legible.incorrect++;
      } else {
        score[gold.state].total++;
        if (!prediction) score[gold.state].missedRows++;
        else if (actual === null) score[gold.state].abstained++;
        else score[gold.state].filled++;
      }
      if (!prediction || !agrees(field, gold, actual))
        everyFieldCorrect = false;
    }
    if (expected.expectedLicenseNo) {
      knownLicenses++;
      if (prediction?.candidates?.[0] === expected.expectedLicenseNo)
        top1Correct++;
      if (
        prediction?.candidates?.slice(0, 3).includes(expected.expectedLicenseNo)
      )
        top3Correct++;
    }
  }
  for (const field of FIELDS) {
    const score = fields[field];
    score.legible.accuracy = ratio(score.legible.correct, score.legible.total);
    for (const state of ["absent", "illegible"] as const)
      score[state].abstentionRate = ratio(
        score[state].abstained,
        score[state].total,
      );
  }
  const matchedRows = assignment.filter((index) => index >= 0).length;
  const unmatchableReferenceRows = reference.medications.filter(
    (row) => row.fields.name.state !== "legible",
  ).length;
  return {
    caseId: reference.caseId,
    bagId: reference.bagId,
    split: reference.split,
    referenceStatus: reference.referenceStatus,
    humanValidated: reference.referenceStatus !== "ai_draft",
    matchingPolicy: "exact_name_maximum_field_agreement_v1",
    referenceRows: reference.medications.length,
    predictedRows: predictions.length,
    matchedRows,
    missedRows: reference.medications.length - matchedRows,
    extraRows: predictions.length - matchedRows,
    unmatchableReferenceRows,
    matches: reference.medications.map((row, index) => ({
      referenceId: row.id,
      predictionIndex: assignment[index] < 0 ? null : assignment[index],
    })),
    fields,
    top1: {
      correct: top1Correct,
      total: knownLicenses,
      rate: ratio(top1Correct, knownLicenses),
    },
    top3: {
      correct: top3Correct,
      total: knownLicenses,
      rate: ratio(top3Correct, knownLicenses),
    },
    wholeBag: unmatchableReferenceRows
      ? null
      : everyFieldCorrect &&
        matchedRows === reference.medications.length &&
        matchedRows === predictions.length,
  };
}

export interface UsageRequest {
  /** Total input includes cached reads and cache writes; these are disjoint subsets. */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface RateCard {
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWritePerMillion: number;
}

export type RunStatus = "succeeded" | "failed" | "partial" | "refused";

export interface EvaluationRun {
  runId: string;
  caseId: string;
  bagId: string;
  split: Split;
  condition: string;
  repeatId: number;
  status: RunStatus;
  latencyMs: number | null;
  referenceStatus?: ReferenceStatus;
  requests?: readonly UsageRequest[] | null;
  recognition?: RecognitionScore;
}

export interface LatencySummary {
  known: number;
  unknown: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maximumMs: number | null;
  method: "nearest_rank";
}

interface TokenSummary {
  knownTotal: number;
  knownRequests: number;
  unknownRequests: number;
  complete: boolean;
}

export interface RunGroupSummary {
  runs: number;
  uniqueCases: number;
  uniqueBags: number;
  uniqueCaseRepeats: number;
  repeatIds: readonly number[];
  additionalRepeatRuns: number;
  statuses: Readonly<Record<RunStatus, number>>;
  successRate: number | null;
  referenceStatuses: Readonly<Record<ReferenceStatus | "unspecified", number>>;
  latency: {
    all: LatencySummary;
    succeeded: LatencySummary;
    unsuccessful: LatencySummary;
  };
  usage: {
    requests: number;
    runsWithUnknownRequests: number;
    inputTokens: TokenSummary;
    outputTokens: TokenSummary;
    cachedInputTokens: TokenSummary;
    cacheWriteTokens: TokenSummary;
  };
  cost: {
    currency: string | null;
    exactTotal: number | null;
    knownExactSubtotal: number | null;
    exactRequests: number;
    unknownCostRequests: number;
    conservativeTotalUpperEstimate: number | null;
    knownUpperEstimateSubtotal: number | null;
    upperEstimateRequests: number;
    upperEstimateMethod: "all_input_at_highest_input_rate";
  };
  recognition: {
    scoredRuns: number;
    unscoredRuns: number;
    wholeBagScorableRuns: number;
    wholeBagCorrectRuns: number;
    /** Conditional on runs with a scorable reference and a recorded score. */
    wholeBagRate: number | null;
    /** Unscored/failed runs remain in this conservative end-to-end denominator. */
    wholeBagSuccessRateAllRuns: number | null;
    humanValidatedRuns: number;
    provisionalRuns: number;
  };
}

export interface RunsSummary extends RunGroupSummary {
  groups: readonly (RunGroupSummary & {
    condition: string;
    split: Split;
  })[];
}

function validNonnegative(
  value: number | null | undefined,
  name: string,
  integer = false,
): void {
  if (
    value !== null &&
    value !== undefined &&
    (!Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isInteger(value)))
  )
    throw Error(`Invalid ${name}`);
}

function latencySummary(runs: readonly EvaluationRun[]): LatencySummary {
  const values = runs
    .map((run) => run.latencyMs)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const percentile = (p: number) =>
    values.length
      ? values[Math.max(0, Math.ceil(values.length * p) - 1)]
      : null;
  return {
    known: values.length,
    unknown: runs.length - values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maximumMs: values.at(-1) ?? null,
    method: "nearest_rank",
  };
}

function summarizeGroup(
  runs: readonly EvaluationRun[],
  rateCard?: RateCard,
): RunGroupSummary {
  const statuses: Record<RunStatus, number> = {
    succeeded: 0,
    failed: 0,
    partial: 0,
    refused: 0,
  };
  const referenceStatuses: Record<ReferenceStatus | "unspecified", number> = {
    ai_draft: 0,
    human_reviewed: 0,
    adjudicated: 0,
    unspecified: 0,
  };
  for (const run of runs) {
    statuses[run.status]++;
    referenceStatuses[
      run.referenceStatus ?? run.recognition?.referenceStatus ?? "unspecified"
    ]++;
  }
  const requests = runs.flatMap((run) => [...(run.requests ?? [])]);
  const runsWithUnknownRequests = runs.filter(
    (run) => run.requests === undefined || run.requests === null,
  ).length;
  const tokens = (field: keyof UsageRequest): TokenSummary => {
    const known = requests
      .map((request) => request[field])
      .filter((value): value is number => typeof value === "number");
    return {
      knownTotal: known.reduce((sum, value) => sum + value, 0),
      knownRequests: known.length,
      unknownRequests: requests.length - known.length,
      complete:
        known.length === requests.length && runsWithUnknownRequests === 0,
    };
  };
  let exactSubtotal = 0;
  let upperSubtotal = 0;
  let exactRequests = 0;
  let upperEstimateRequests = 0;
  if (rateCard) {
    for (const request of requests) {
      const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens } =
        request;
      if (inputTokens == null || outputTokens == null) continue;
      const highestInputRate = Math.max(
        rateCard.inputPerMillion,
        rateCard.cachedInputPerMillion,
        rateCard.cacheWritePerMillion,
      );
      upperSubtotal +=
        (inputTokens * highestInputRate +
          outputTokens * rateCard.outputPerMillion) /
        1_000_000;
      upperEstimateRequests++;
      if (cachedInputTokens == null || cacheWriteTokens == null) continue;
      exactSubtotal +=
        ((inputTokens - cachedInputTokens - cacheWriteTokens) *
          rateCard.inputPerMillion +
          cachedInputTokens * rateCard.cachedInputPerMillion +
          cacheWriteTokens * rateCard.cacheWritePerMillion +
          outputTokens * rateCard.outputPerMillion) /
        1_000_000;
      exactRequests++;
    }
  }
  const scored = runs
    .map((run) => run.recognition)
    .filter((value): value is RecognitionScore => value !== undefined);
  const scorable = scored.filter((score) => score.wholeBag !== null);
  const wholeBagCorrectRuns = scorable.filter((score) => score.wholeBag).length;
  const caseConditions = new Set(
    runs.map((run) => JSON.stringify([run.caseId, run.condition])),
  );
  return {
    runs: runs.length,
    uniqueCases: new Set(runs.map((run) => run.caseId)).size,
    uniqueBags: new Set(runs.map((run) => run.bagId)).size,
    uniqueCaseRepeats: new Set(
      runs.map((run) => JSON.stringify([run.caseId, run.repeatId])),
    ).size,
    repeatIds: [...new Set(runs.map((run) => run.repeatId))].sort(
      (a, b) => a - b,
    ),
    additionalRepeatRuns: runs.length - caseConditions.size,
    statuses,
    successRate: ratio(statuses.succeeded, runs.length),
    referenceStatuses,
    latency: {
      all: latencySummary(runs),
      succeeded: latencySummary(
        runs.filter((run) => run.status === "succeeded"),
      ),
      unsuccessful: latencySummary(
        runs.filter((run) => run.status !== "succeeded"),
      ),
    },
    usage: {
      requests: requests.length,
      runsWithUnknownRequests,
      inputTokens: tokens("inputTokens"),
      outputTokens: tokens("outputTokens"),
      cachedInputTokens: tokens("cachedInputTokens"),
      cacheWriteTokens: tokens("cacheWriteTokens"),
    },
    cost: {
      currency: rateCard?.currency ?? null,
      exactTotal:
        rateCard &&
        exactRequests === requests.length &&
        runsWithUnknownRequests === 0
          ? exactSubtotal
          : null,
      knownExactSubtotal: rateCard ? exactSubtotal : null,
      exactRequests,
      unknownCostRequests: requests.length - exactRequests,
      conservativeTotalUpperEstimate:
        rateCard &&
        upperEstimateRequests === requests.length &&
        runsWithUnknownRequests === 0
          ? upperSubtotal
          : null,
      knownUpperEstimateSubtotal: rateCard ? upperSubtotal : null,
      upperEstimateRequests,
      upperEstimateMethod: "all_input_at_highest_input_rate",
    },
    recognition: {
      scoredRuns: scored.length,
      unscoredRuns: runs.length - scored.length,
      wholeBagScorableRuns: scorable.length,
      wholeBagCorrectRuns,
      wholeBagRate: ratio(wholeBagCorrectRuns, scorable.length),
      wholeBagSuccessRateAllRuns: ratio(wholeBagCorrectRuns, runs.length),
      humanValidatedRuns: scored.filter((score) => score.humanValidated).length,
      provisionalRuns: scored.filter((score) => !score.humanValidated).length,
    },
  };
}

/** Pure aggregation. Duplicate observations and bag-level split leakage are errors. */
export function summarizeRuns(
  runs: readonly EvaluationRun[],
  rateCard?: RateCard,
): RunsSummary {
  if (rateCard) {
    nonempty(rateCard.currency, "currency");
    for (const field of [
      "inputPerMillion",
      "outputPerMillion",
      "cachedInputPerMillion",
      "cacheWritePerMillion",
    ] as const) {
      if (typeof rateCard[field] !== "number")
        throw Error(`Missing rate card field: ${field}`);
      validNonnegative(rateCard[field], field);
    }
  }
  const runIds = new Set<string>();
  const observations = new Set<string>();
  const bagSplits = new Map<string, Split>();
  const cases = new Map<string, string>();
  for (const run of runs) {
    for (const field of ["runId", "caseId", "bagId", "condition"] as const)
      nonempty(run[field], field);
    validateSplit(run.split);
    if (run.referenceStatus) validateReferenceStatus(run.referenceStatus);
    if (!["succeeded", "failed", "partial", "refused"].includes(run.status))
      throw Error(`Invalid run status: ${run.status}`);
    if (!Number.isInteger(run.repeatId) || run.repeatId < 1)
      throw Error(`Invalid repeatId: ${run.repeatId}`);
    validNonnegative(run.latencyMs, "latencyMs");
    if (runIds.has(run.runId)) throw Error(`Duplicate runId: ${run.runId}`);
    runIds.add(run.runId);
    const observation = JSON.stringify([
      run.caseId,
      run.condition,
      run.repeatId,
    ]);
    if (observations.has(observation))
      throw Error(`Duplicate case/condition/repeat: ${observation}`);
    observations.add(observation);
    const split = bagSplits.get(run.bagId);
    if (split && split !== run.split)
      throw Error(`Bag split leakage: ${run.bagId}`);
    bagSplits.set(run.bagId, run.split);
    const bagId = cases.get(run.caseId);
    if (bagId && bagId !== run.bagId)
      throw Error(`Case changes bag identity: ${run.caseId}`);
    cases.set(run.caseId, run.bagId);
    if (run.recognition) {
      validateReferenceStatus(run.recognition.referenceStatus);
      if (
        run.recognition.caseId !== run.caseId ||
        run.recognition.bagId !== run.bagId ||
        run.recognition.split !== run.split ||
        (run.referenceStatus &&
          run.referenceStatus !== run.recognition.referenceStatus) ||
        run.recognition.humanValidated !==
          (run.recognition.referenceStatus !== "ai_draft")
      )
        throw Error(`Recognition provenance mismatch: ${run.runId}`);
    }
    for (const request of run.requests ?? []) {
      for (const field of [
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheWriteTokens",
      ] as const)
        validNonnegative(request[field], field, true);
      if (
        request.inputTokens != null &&
        (request.cachedInputTokens ?? 0) + (request.cacheWriteTokens ?? 0) >
          request.inputTokens
      )
        throw Error(`Cache subsets exceed total input: ${run.runId}`);
    }
  }
  const groups = new Map<
    string,
    { condition: string; split: Split; runs: EvaluationRun[] }
  >();
  for (const run of runs) {
    const key = JSON.stringify([run.condition, run.split]);
    if (!groups.has(key))
      groups.set(key, {
        condition: run.condition,
        split: run.split,
        runs: [],
      });
    groups.get(key)!.runs.push(run);
  }
  return {
    ...summarizeGroup(runs, rateCard),
    groups: [...groups.values()]
      .sort(
        (a, b) =>
          a.condition.localeCompare(b.condition) ||
          a.split.localeCompare(b.split),
      )
      .map((group) => ({
        condition: group.condition,
        split: group.split,
        ...summarizeGroup(group.runs, rateCard),
      })),
  };
}
