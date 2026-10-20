/** Five bounded, serial, real-AI seminar flows. No replacement runs after failures. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aiConnection, aiModelRoute, config } from "../server/config.js";

const runReal = process.argv.includes("--run-real-ai");
const runs = 5;
const connection = aiConnection();
const configuredRuntime = {
  provider: config.aiProvider,
  textModel: config.textModel,
  visionModel: config.visionModel,
  textFallbackModels: aiModelRoute().slice(1),
  visionFallbackModels: aiModelRoute(true).slice(1),
};
const directory = resolve(
  ".local/seminar-stability-" +
    Date.now() +
    "-" +
    crypto.randomUUID().slice(0, 8),
);
const summary: any = {
  check: "five-consecutive-real-seminar-flows",
  createdAt: new Date().toISOString(),
  status: "not_run",
  workflowStatus: "not_run",
  contentQaStatus: "pending",
  syntheticPatient: true,
  mockedAI: false,
  plannedRuns: runs,
  maxLogicalJobs: runs * 3,
  replacementRuns: 0,
  configuredRuntime,
  endpoint: new URL(connection.base).origin,
  aiConfigured: !!connection.key,
  policy:
    "Five serial runs, each with a new isolated database and one recognition plus two bundles. Every attempt and failure remains in the denominator. Both viewports reuse that round's real results. Semantic source review remains a separate recorded step.",
  directory,
  rounds: [],
};
const save = async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
};
const saveLatest = async () => {
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/seminar-stability-latest.json",
    JSON.stringify(summary, null, 2),
  );
};

if (!runReal) {
  console.log(
    "No AI called. Explicit --run-real-ai is required for five real flows (at most 15 logical jobs). Build the application first.",
  );
} else if (!connection.key) {
  summary.status = "blocked_missing_api_key";
  summary.workflowStatus = "not_run";
  summary.contentQaStatus = "not_ready";
  summary.reason =
    "The selected " +
    connection.label +
    " API key is not configured. No child server, model request, or replacement provider was started.";
  summary.finishedAt = new Date().toISOString();
  summary.totals = {
    completedRounds: 0,
    passedRounds: 0,
    failedRounds: 0,
    notRunRounds: runs,
    attemptedLogicalJobs: 0,
    succeededLogicalJobs: 0,
    failedLogicalJobs: 0,
    upstreamRequests: 0,
  };
  await save();
  await saveLatest();
  console.log(
    JSON.stringify(
      {
        status: summary.status,
        workflowStatus: summary.workflowStatus,
        summary: resolve(directory, "summary.json"),
        configuredRuntime,
        totals: summary.totals,
        reason: summary.reason,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  summary.status = "running";
  summary.workflowStatus = "running";
  await save();
  for (let index = 0; index < runs; index++) {
    const round: any = {
      round: index + 1,
      startedAt: new Date().toISOString(),
      status: "failed",
    };
    summary.rounds.push(round);
    await save();
    console.log(`Starting bounded seminar round ${index + 1}/${runs}`);
    let output = "";
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--env-file-if-exists=.env",
          "tools/check-seminar-flow.ts",
          "--run-real-ai",
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
        process.stderr.write(chunk);
      });
      round.exitCode = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("exit", done);
      });
      const report = JSON.parse(
        await readFile(".local/reports/seminar-real-ai-flow.json", "utf8"),
      );
      if (Date.parse(report.createdAt) < Date.parse(round.startedAt))
        throw Error(
          "No new report from this round; stale latest report rejected.",
        );
      await writeFile(
        resolve(directory, `round-${index + 1}.json`),
        JSON.stringify(report, null, 2),
      );
      Object.assign(round, {
        status: report.status,
        report: resolve(report.directory, "report.json"),
        provider: report.provider,
        textModel: report.textModel,
        visionModel: report.visionModel,
        fallbackPolicy: report.fallbackPolicy,
        runtimeAI: report.runtimeAI,
        sourceDatabase: report.sourceDatabase,
        steps: report.steps.length,
        passedSteps: report.steps.filter((step: any) => step.passed).length,
        failures: report.steps.filter((step: any) => !step.passed),
        jobs: report.jobs.map((job: any) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          latencyMs: job.latencyMs,
          tokens: job.tokens,
          usageKnown: job.usageKnown,
          usageMayBeIncomplete: job.usageMayBeIncomplete,
          error: job.error,
          actualModels: job.actualModels,
          usedMultipleModels: job.usedMultipleModels,
          fallbackUsed: job.fallbackUsed,
          fallbackRequestCount: job.fallbackRequestCount,
          metricsTraceMatch: job.metricsTraceMatch,
          aiRequests: job.aiRequests,
          upstreamRoute: job.upstreamRoute,
        })),
        upstreamRequests: report.upstreamRequests,
        generatedLearning: report.generatedLearning || [],
        browserErrors: report.browserErrors,
        requestFailures: report.requestFailures,
      });
      const runtime = report.runtimeAI;
      round.runtimeMatchesConfigured =
        !!runtime &&
        Object.entries(configuredRuntime).every(
          ([key, value]) =>
            JSON.stringify(runtime[key]) === JSON.stringify(value),
        );
      if (!round.runtimeMatchesConfigured) {
        round.status = "failed";
        round.error =
          "The isolated runtime provider/model/effective fallback metadata does not match the selected configuration, or the runtime was not started.";
      }
      if (round.exitCode !== 0) round.status = "failed";
    } catch (error) {
      round.error = error instanceof Error ? error.message : String(error);
    } finally {
      round.finishedAt = new Date().toISOString();
      round.elapsedMs =
        Date.parse(round.finishedAt) - Date.parse(round.startedAt);
      await writeFile(resolve(directory, `round-${index + 1}.log`), output);
      await save();
    }
  }
  const jobs = summary.rounds.flatMap((round: any) => round.jobs || []);
  const requests = summary.rounds.flatMap(
    (round: any) => round.upstreamRequests || [],
  );
  const passed = summary.rounds.filter(
    (round: any) => round.status === "passed",
  ).length;
  summary.workflowStatus = passed === runs ? "passed" : "failed";
  summary.status =
    summary.workflowStatus === "passed" ? "pending_content_review" : "failed";
  summary.finishedAt = new Date().toISOString();
  summary.totals = {
    completedRounds: summary.rounds.length,
    passedRounds: passed,
    failedRounds: runs - passed,
    attemptedLogicalJobs: jobs.length,
    succeededLogicalJobs: jobs.filter((job: any) => job.status === "succeeded")
      .length,
    failedLogicalJobs: jobs.filter((job: any) => job.status !== "succeeded")
      .length,
    upstreamRequests: requests.length,
    upstreamFailures: requests.filter(
      (request: any) =>
        request.error || request.status < 200 || request.status >= 300,
    ).length,
    unreadableUpstreamResponses: requests.filter(
      (request: any) => request.unreadableResponse,
    ).length,
    applicationRequestErrors: jobs.reduce(
      (sum: number, job: any) =>
        sum +
        (job.aiRequests || []).filter((request: any) => request.error).length,
      0,
    ),
    jobsUsingMultipleModels: jobs.filter((job: any) => job.usedMultipleModels)
      .length,
    jobsUsingFallback: jobs.filter((job: any) => job.fallbackUsed).length,
    fallbackRequests: jobs.reduce(
      (sum: number, job: any) => sum + (job.fallbackRequestCount || 0),
      0,
    ),
    requestMetricsMatched: jobs.every((job: any) => job.metricsTraceMatch),
    knownReportedTokens: jobs.reduce(
      (sum: number, job: any) => sum + (job.tokens || 0),
      0,
    ),
    usageMayBeIncomplete: jobs.some((job: any) => job.usageMayBeIncomplete),
    browserErrors: summary.rounds.reduce(
      (sum: number, round: any) => sum + (round.browserErrors?.length || 0),
      0,
    ),
  };
  await save();
  await saveLatest();
  console.log(
    JSON.stringify(
      {
        status: summary.status,
        workflowStatus: summary.workflowStatus,
        contentQaStatus: summary.contentQaStatus,
        summary: resolve(directory, "summary.json"),
        totals: summary.totals,
      },
      null,
      2,
    ),
  );
  if (summary.workflowStatus !== "passed") process.exitCode = 1;
}
