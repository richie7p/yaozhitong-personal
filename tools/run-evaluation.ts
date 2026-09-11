import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Nvidia,
  grounded,
  generationPrompt,
  selectChunks,
  OutputSchema,
  GROUNDING_VERSION,
} from "../server/ai.js";
import { config } from "../server/config.js";
import { hash } from "../server/domain.js";
const [input, condition, output, maximum = "5"] = process.argv.slice(2);
if (
  !input ||
  !output ||
  !["direct", "grounded"].includes(condition) ||
  !Number.isInteger(Number(maximum)) ||
  Number(maximum) < 1 ||
  Number(maximum) > 100
)
  throw Error(
    "Usage: tsx tools/run-evaluation.ts approved-cases.jsonl direct|grounded output.jsonl maxCases(1..100)",
  );
const raw = await readFile(input, "utf8");
const rows = raw
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((x) => JSON.parse(x));
if (
  rows.some(
    (r) =>
      r.humanReviewed !== true ||
      r.deidentified !== true ||
      !r.question ||
      !Array.isArray(r.chunks) ||
      !r.chunks.length ||
      !["test", "development"].includes(r.split),
  )
)
  throw Error(
    "Only reviewed, deidentified, source-backed cases with a declared split are accepted. Generated draft QA cases are not benchmark gold data.",
  );
await mkdir(dirname(output), { recursive: true });
const prior = await readFile(output, "utf8").catch((e: any) => {
  if (e.code !== "ENOENT") throw e;
  return "";
});
const finished = new Set(
  prior
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s).caseKey),
);
const datasetHash = hash(raw);
let completed = 0;
for (const row of rows.slice(0, Number(maximum))) {
  const caseKey = hash(
    JSON.stringify({
      datasetHash,
      id: row.id,
      condition,
      model: config.textModel,
      prompt: GROUNDING_VERSION,
    }),
  );
  if (finished.has(caseKey)) continue;
  const llm = new Nvidia(),
    start = Date.now();
  let result: any;
  try {
    const chunks = selectChunks(row.chunks, row.question),
      context = row.context || {},
      kind = row.kind || "chat";
    if (condition === "grounded")
      result = await grounded(llm, row.question, chunks, context, kind);
    else {
      const candidate = OutputSchema.parse(
        await llm.json(generationPrompt, {
          question: row.question,
          kind,
          context,
          chunks,
        }),
      );
      result = {
        ...candidate,
        chunks,
        verification: "unverified_experiment_only",
      };
    }
  } catch (e: any) {
    result = {
      status: "failed",
      claims: [],
      chunks: row.chunks,
      error: { code: e.code || "evaluation_failed" },
    };
  }
  await appendFile(
    output,
    JSON.stringify({
      id: row.id,
      caseKey,
      datasetHash,
      split: row.split,
      condition,
      model: config.textModel,
      promptVersion: GROUNDING_VERSION,
      latencyMs: Date.now() - start,
      tokens: llm.tokens,
      ...result,
    }) + "\n",
  );
  completed++;
  console.log(JSON.stringify({ completed, id: row.id, status: result.status }));
}
