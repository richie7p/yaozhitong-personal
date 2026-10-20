/** Bounded, single-attempt model comparison on a disclosed synthetic bag only. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { recognize, type Llm } from "../server/ai.js";
import { scoreDrug } from "../server/catalog.js";
import { aiConnection, config } from "../server/config.js";
import type { Drug } from "../shared/schema.js";

const runRealAI = process.argv.includes("--run-real-ai");
const candidateFlag = process.argv.indexOf("--candidate");
const candidate =
  candidateFlag >= 0 ? process.argv[candidateFlag + 1] : undefined;
if (
  candidateFlag >= 0 &&
  (!candidate || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(candidate))
)
  throw Error("Use --candidate with one exact official NVIDIA model ID.");
const inventoryFlag = process.argv.indexOf("--inventory-file");
const inventoryFile =
  inventoryFlag >= 0
    ? process.argv[inventoryFlag + 1]
    : ".local/reports/seminar-model-probes.json";
if (!inventoryFile || inventoryFile.startsWith("--"))
  throw Error("Missing --inventory-file path.");
const models = candidate
  ? [candidate]
  : [
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
    ];
const fixtureDirectory = resolve(".local/seminar-demo-v9-20261019");
const imagePath = resolve(fixtureDirectory, "synthetic-two-medication-bag.png");
const image = await readFile(imagePath);
const database = JSON.parse(
  await readFile(resolve(fixtureDirectory, "db.json"), "utf8"),
);
const catalog: Drug[] = JSON.parse(
  await readFile(
    resolve(fixtureDirectory, "blobs", database.settings.catalog.path),
    "utf8",
  ),
);
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
if (
  inventory.inventoryStatus !== 200 ||
  !Array.isArray(inventory.availableModels)
)
  throw Error(
    "Use an authenticated successful inventory report with availableModels.",
  );
for (const model of models)
  if (!inventory.availableModels.includes(model))
    throw Error(
      "Candidate is absent from authenticated saved inventory: " + model,
    );
const repeats = candidate ? 2 : 4;
const maximumUpstreamHttpRequests = models.length * repeats;
const directory = resolve(
  ".local/seminar-vision-" +
    (candidate ? "candidate-" : "compare-") +
    Date.now(),
);
await mkdir(directory, { recursive: true });
const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const deadlineMs = candidate ? 28000 : 45000;
const parametersFor = (model: string) => ({
  temperature: 0.1,
  max_tokens: 2600,
  stream: false,
  ...(/^(nvidia\/nemotron-3|qwen\/qwen3|google\/diffusiongemma-)/.test(model)
    ? { chat_template_kwargs: { enable_thinking: false } }
    : {}),
  ...(model === "z-ai/glm-5.3-flash"
    ? {
        reasoning_effort: "low",
        chat_template_kwargs: { clear_thinking: true },
      }
    : {}),
});
const report: any = {
  check: "seminar-vision-model-comparison",
  createdAt: new Date().toISOString(),
  runRealAI,
  syntheticInput: true,
  imagePath,
  imageSha256: sha256(image),
  models,
  inventoryFile: resolve(inventoryFile),
  inventoryStatus: inventory.inventoryStatus,
  inventoryCreatedAt: inventory.createdAt,
  parametersByModel: Object.fromEntries(
    models.map((model) => [model, parametersFor(model)]),
  ),
  deadlineMs,
  repeatsPerModel: repeats,
  maximumUpstreamHttpRequests,
  actualUpstreamHttpRequests: 0,
  tokenReporting:
    "Only usage explicitly returned by an upstream response is known. A null token count, including a failed 503, is unknown usage rather than zero.",
  policy:
    (candidate
      ? "Two fixed chronological calls for one specified candidate"
      : "Four chronological paired repeats") +
    "; one upstream HTTP per sample, no hidden retries or replacement runs. Production recognize prompt/schema/dose checks and full official-catalog scoring are reused. This does not measure real-photo accuracy or long-term availability.",
  officialDocumentation:
    candidate === "z-ai/glm-5.3-flash"
      ? ["https://build.nvidia.com/z-ai/glm-5.3-flash"]
      : [
          "https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/modelcard",
          "https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b",
          "https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b",
        ],
  samples: [],
};
const save = () =>
  writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
await save();
if (runRealAI) {
  if (config.aiProvider !== "nvidia")
    throw Error("This comparison requires the configured NVIDIA provider.");
  const connection = aiConnection();
  if (!connection.key) throw Error("NVIDIA key is not configured.");
  if (new URL(connection.base).origin !== "https://integrate.api.nvidia.com")
    throw Error("Only the official NVIDIA endpoint is allowed.");
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const model of models) {
      const sample: any = {
        sequence: report.samples.length + 1,
        repeat,
        model,
        startedAt: new Date().toISOString(),
        passed: false,
        tokens: null,
        usageKnown: false,
      };
      report.samples.push(sample);
      const prefix = "sample-" + String(sample.sequence).padStart(2, "0");
      const started = Date.now();
      const adapter: Llm = {
        async json(system, content, vision) {
          if (!vision) throw Error("Vision-only comparison adapter.");
          if (report.actualUpstreamHttpRequests >= maximumUpstreamHttpRequests)
            throw Error("HTTP budget exhausted.");
          const request = {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content },
            ],
            ...parametersFor(model),
          };
          await writeFile(
            resolve(directory, prefix + "-request.json"),
            JSON.stringify(
              {
                ...request,
                messages: [
                  { role: "system", content: system },
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: "請辨識這張藥袋，保留不確定欄位。",
                      },
                      {
                        type: "image_url",
                        image_url: {
                          url:
                            "[synthetic PNG redacted; sha256=" +
                            sha256(image) +
                            "]",
                        },
                      },
                    ],
                  },
                ],
              },
              null,
              2,
            ),
          );
          sample.promptSha256 = sha256(system);
          report.actualUpstreamHttpRequests++;
          const response = await fetch(
            connection.base.replace(/\/$/, "") + "/chat/completions",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + connection.key,
                "content-type": "application/json",
              },
              body: JSON.stringify(request),
              signal: AbortSignal.timeout(deadlineMs),
            },
          );
          sample.httpStatus = response.status;
          sample.headersLatencyMs = Date.now() - started;
          const raw = await response.text();
          sample.bodyLatencyMs = Date.now() - started;
          await writeFile(resolve(directory, prefix + "-response.txt"), raw);
          sample.rawResponsePath = resolve(directory, prefix + "-response.txt");
          if (!response.ok) throw Error("upstream_http_" + response.status);
          const body = JSON.parse(raw);
          sample.usage = body.usage ?? null;
          sample.tokens = Number.isFinite(body.usage?.total_tokens)
            ? body.usage.total_tokens
            : null;
          sample.usageKnown = sample.tokens !== null;
          sample.reasoningTokens = Number.isFinite(
            body.usage?.completion_tokens_details?.reasoning_tokens,
          )
            ? body.usage.completion_tokens_details.reasoning_tokens
            : null;
          sample.reasoningCharacters = String(
            body.choices?.[0]?.message?.reasoning_content || "",
          ).length;
          sample.finishReason = body.choices?.[0]?.finish_reason;
          if (sample.finishReason === "length") throw Error("ai_output_limit");
          const text = String(body.choices?.[0]?.message?.content || "")
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .trim()
            .replace(/^```(?:json)?\s*/, "")
            .replace(/```$/, "");
          return JSON.parse(text);
        },
      };
      try {
        const result = await recognize(adapter, image, "image/png");
        const matched = result.medications.map((med) => ({
          ...med,
          candidates: catalog
            .map((d) => ({
              ...d,
              score: scoreDrug(d, med.name, med.strength || "", med.form || ""),
            }))
            .filter((d) => d.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 12),
        }));
        await writeFile(
          resolve(directory, prefix + "-validated-result.json"),
          JSON.stringify({ ...result, medications: matched }, null, 2),
        );
        if (result.status !== "succeeded" || matched.length !== 2)
          throw Error(
            "Expected exactly two successful medication transcriptions.",
          );
        for (const [index, licenseNo] of [
          "內衛成製字第000544號",
          "衛署藥製字第026087號",
        ].entries()) {
          const med = matched.find((m) =>
            m.candidates.some((c) => c.licenseNo === licenseNo),
          );
          if (!med)
            throw Error("Missing correct official candidate: " + licenseNo);
          if (
            med.doseAmount !== 1 ||
            med.doseUnit !== (index === 0 ? "粒" : "錠") ||
            med.frequencyRaw !== (index === 0 ? "TID" : "PRN")
          )
            throw Error(
              "Incorrect prescribed dose/unit/frequency for: " + licenseNo,
            );
          if (med.durationDays !== (index === 0 ? 7 : null))
            throw Error(
              "Incorrect supplied/missing duration for: " + licenseNo,
            );
          if (med.route !== "口服")
            throw Error("Incorrect supplied route for: " + licenseNo);
        }
        sample.passed = true;
      } catch (error) {
        sample.error =
          error instanceof Error
            ? error.name + ": " + error.message
            : String(error);
      } finally {
        sample.elapsedMs = Date.now() - started;
        await save();
        console.log(
          JSON.stringify({
            sequence: sample.sequence,
            repeat,
            model,
            passed: sample.passed,
            status: sample.httpStatus,
            elapsedMs: sample.elapsedMs,
            tokens: sample.tokens,
            error: sample.error,
          }),
        );
      }
    }
  }
  report.summary = models.map((model) => {
    const rows = report.samples.filter((s: any) => s.model === model);
    const successfulTimes = rows
      .filter((s: any) => s.passed)
      .map((s: any) => s.elapsedMs)
      .sort((a: number, b: number) => a - b);
    return {
      model,
      samples: rows.length,
      passed: successfulTimes.length,
      failed: rows.length - successfulTimes.length,
      httpStatuses: rows.map((s: any) => s.httpStatus ?? null),
      successfulLatencyMs: successfulTimes,
      maximumObservedLatencyMs: Math.max(...rows.map((s: any) => s.elapsedMs)),
    };
  });
  report.completedAt = new Date().toISOString();
  report.status = "completed";
  await save();
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    candidate
      ? ".local/reports/seminar-vision-candidate-comparison.json"
      : ".local/reports/seminar-vision-model-comparison.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify({
    reportPath: resolve(directory, "report.json"),
    summary: report.summary,
    actualUpstreamHttpRequests: report.actualUpstreamHttpRequests,
  }),
);
