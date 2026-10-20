/** Opt-in, minimal connection check through the production client. No medical input. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { config } from "../server/config.js";
import { JsonLlm } from "../server/llm.js";

if (!process.argv.includes("--run-real-ai"))
  throw Error("Explicit --run-real-ai is required; no request was sent.");
if (
  config.aiProvider !== "openai" ||
  !config.openaiKey ||
  config.textModel !== "gpt-6-luna" ||
  config.visionModel !== "gpt-6-luna" ||
  config.openaiBase.replace(/\/$/, "") !== "https://api.openai.com/v1"
)
  throw Error("First complete the local GPT-6 Luna preparation check.");

const directory = resolve(".local/openai-connection-" + Date.now());
await mkdir(directory, { recursive: true });
process.env.SEMINAR_AI_TRACE_DIR = directory;
// Same non-blocking, credential-redacted observation as the real flow runner.
const trace = await import("./trace-seminar-ai.mjs");
const llm = new JsonLlm();
const started = Date.now();
const report: any = {
  startedAt: new Date().toISOString(),
  scope: "minimal-connection-only",
  directory,
  provider: "openai",
  model: "gpt-6-luna",
  logicalRequests: 1,
  maximumHttpRequests: 3,
  status: "failed",
  fullFlowAcceptance: "not_run",
};
try {
  const result = (await llm.json(
    'This is a connection check. Return only the JSON object {"ok":true}.',
    { task: "synthetic-connection-check" },
  )) as any;
  if (result?.ok !== true) throw Error("Unexpected connection check result.");
  report.status = "passed";
} catch (error: any) {
  report.error = {
    code: /^[a-z_]+$/.test(error?.code || "") ? error.code : "probe_failed",
    status: Number.isInteger(error?.status) ? error.status : null,
  };
  process.exitCode = 1;
}
await trace.flushSeminarAiTraces();
report.httpRequests = llm.requests.length;
report.aiRequests = llm.requests;
report.knownTokens = llm.tokens;
report.usageMayBeIncomplete = llm.requests.some((r) => r.tokens === null);
report.observedResponses = [];
for (let index = 1; index <= llm.requests.length; index++) {
  const saved = JSON.parse(
    await readFile(
      join(directory, `upstream-${String(index).padStart(2, "0")}.json`),
      "utf8",
    ),
  );
  const safeCode = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
      ? value
      : null;
  report.observedResponses.push({
    status: saved.status ?? null,
    actualModel: safeCode(saved.response?.model),
    providerErrorCode: safeCode(saved.response?.error?.code),
    parameter: safeCode(saved.response?.error?.param),
    usage: saved.usage ?? null,
  });
}
report.elapsedMs = Date.now() - started;
report.finishedAt = new Date().toISOString();
await writeFile(
  join(directory, "report.json"),
  JSON.stringify(report, null, 2),
);
await mkdir(".local/reports", { recursive: true });
await writeFile(
  ".local/reports/openai-connection.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
