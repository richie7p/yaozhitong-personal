/** Bounded, uncached production grounded-v9 comparison. Public sources + synthetic adult only. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../server/config.js";
import { grounded, GROUNDING_VERSION, type Llm } from "../server/ai.js";
import type { Leaflet, GroundedResult } from "../shared/schema.js";

const base = config.nvidiaBase.replace(/\/$/, "");
if (base !== "https://integrate.api.nvidia.com/v1" || !config.nvidiaKey)
  throw Error("Official NVIDIA endpoint and a configured key are required.");
const candidates = [
  {
    model: "google/diffusiongemma-26b-a4b-it",
    parameters: { chat_template_kwargs: { enable_thinking: false } },
    documentation: "https://docs.api.nvidia.com/nim/reference/diffusiongemma-26b-a4b-it-infer",
    parameterNote: "The hosted integrate API reference specifies enable_thinking=false. The standalone VLM 1.7 guide's thinking=false differs and is not used for this hosted endpoint.",
  },
  {
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    parameters: { chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" } },
    documentation: "https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html#structured-json-output",
    parameterNote: "Official guide documents enable_thinking=false plus JSON mode for structured output.",
  },
  {
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    parameters: { chat_template_kwargs: { enable_thinking: false } },
    documentation: "https://docs.nvidia.com/nim/large-language-models/2.0.13/get-started/advanced/get-started-nemotron-3.5-super-vl.html#control-reasoning",
    parameterNote: "Official hosted model card accepts text strings and documents enable_thinking=false. No JSON mode is forced; production schema validation remains required.",
  },
  {
    model: "z-ai/glm-5.3-flash",
    parameters: { reasoning_effort: "low", chat_template_kwargs: { clear_thinking: true } },
    documentation: "https://build.nvidia.com/z-ai/glm-5-3-flash/modelcard",
    parameterNote: "Current production GLM low reasoning and clear_thinking parameters retained; no cross-provider fallback and no forced JSON mode.",
  },
];
const selectedModel = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
const choices = candidates.filter((candidate) => selectedModel ? candidate.model === selectedModel : ["google/diffusiongemma-26b-a4b-it", "nvidia/nemotron-3.5-lightning-30b-a3b"].includes(candidate.model));
if (!choices.length) throw Error("Requested candidate is not allowlisted.");
const inventory = JSON.parse(await readFile(".local/reports/seminar-model-probes.json", "utf8"));
if (choices.some((choice) => !inventory.availableModels?.includes(choice.model)))
  throw Error("A selected candidate is absent from the recorded authenticated model inventory.");
const review = JSON.parse(await readFile("data/leaflets/local-reviewed.json", "utf8"));
const database = JSON.parse(await readFile(resolve(config.localPath, "db.json"), "utf8"));
let fixtures: Leaflet[] = [];
for (const reviewed of review.items) {
  const source = Object.values<Leaflet>(database.leaflets).find((item) => item.licenseNo === reviewed.licenseNo && item.sha256 === reviewed.sha256);
  if (!source || new URL(source.sourceUrl).hostname !== "mcp.fda.gov.tw") throw Error("Canonical reviewed public source missing.");
  const bytes = await readFile(resolve(config.localPath, "blobs", source.storagePath));
  if (createHash("sha256").update(bytes).digest("hex") !== reviewed.sha256) throw Error("Reviewed PDF checksum mismatch.");
  fixtures.push(source);
}
if (fixtures.length !== 2) throw Error("Exactly two canonical sources are required.");
const selectedLicense = process.argv.find((arg) => arg.startsWith("--license="))?.slice("--license=".length);
if (selectedLicense) fixtures = fixtures.filter((source) => source.licenseNo === selectedLicense);
if (!fixtures.length) throw Error("Requested source is not in the reviewed fixtures.");
const reportDirectory = resolve(".local/reports/text-model-comparison-" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, "report.json");
const repetitionCount = Number(process.argv.find((arg) => arg.startsWith("--repetitions="))?.split("=")[1] || 1);
const maxRequests = Number(process.argv.find((arg) => arg.startsWith("--max-requests="))?.split("=")[1] || 8);
if (![1, 2].includes(repetitionCount) || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 16) throw Error("Invalid bounded run settings.");
const report: any = {
  createdAt: new Date().toISOString(), endpoint: base, groundingVersion: GROUNDING_VERSION,
  syntheticPatient: true, mockedAI: false, cacheEnabled: false, retryEnabled: false,
  maxHttpRequests: maxRequests, actualHttpRequests: 0, deadlineMs: 45000, maxGenerationTokens: config.aiTextMaxTokens,
  repeatCountPerModelPerSource: repetitionCount, choices,
  scope: "Full current production grounded() prompts with selected reviewed public leaflets and a synthetic adult age 32 reporting asthma. No real patient data. No outputs repaired or relaxed to pass. A finite comparison is not an uptime guarantee.",
  sources: fixtures.map((f) => ({ licenseNo: f.licenseNo, sourceUrl: f.sourceUrl, sha256: f.sha256, version: f.version })),
  requests: [], runs: [],
};
const redact = (value: unknown) => {
  let text = JSON.stringify(value, null, 2);
  for (const key of [config.nvidiaKey, config.openaiKey].filter(Boolean)) text = text.split(key).join("[redacted]");
  return text.replace(/account '[^']+'/g, "account '[redacted]'");
};
const save = () => writeFile(reportPath, redact(report));
await save();
const compact = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
function validate(result: GroundedResult, source: Leaflet) {
  const checks: Record<string, boolean> = {
    supported: result.status === "supported",
    purpose: result.claims.some((c) => c.category === "purpose"),
    claims: result.claims.length > 0,
    quiz: result.quiz.length >= 1 && result.quiz.length <= 2,
    sourceVersion: result.sourceVersions[source.licenseNo] === source.version,
    originalQuotes: [...result.claims.flatMap((c) => c.citations), ...result.quiz.flatMap((q) => q.citations)].every((q) => {
      const canonical = source.chunks.find((c) => c.id === q.chunkId);
      return !!canonical && compact(canonical.text).includes(compact(q.quote));
    }),
    sourceExplanations: result.quiz.every((q) => {
      const heading = /^依仿單「(?:適應症|警語|注意事項|副作用)」原文：/;
      const lines = q.explain.replace(heading, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return q.explanationKind === "source_quote" && heading.test(q.explain) && lines.length > 0 && lines.every((line) => q.citations.some((c) => compact(c.quote).includes(compact(line))));
    }),
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}
for (let repetition = 1; repetition <= repetitionCount; repetition++) {
  for (const source of fixtures) {
    // Alternate candidate order to avoid giving one model only the warm-up slot.
    for (const choice of repetition === 1 ? choices : [...choices].reverse()) {
      const run: any = { id: report.runs.length + 1, model: choice.model, repetition, licenseNo: source.licenseNo, requests: [] };
      report.runs.push(run);
      const started = Date.now();
      const llm: Llm = {
        async json(system, content, vision) {
          if (vision) throw Error("Text-only comparison refuses image input.");
          if (report.actualHttpRequests >= report.maxHttpRequests) throw Error("HTTP budget exhausted.");
          const expectedIds = (content as any)?.expectedIds;
          const stage = Array.isArray(expectedIds) ? "verification" : "generation";
          const maxTokens = stage === "verification" ? Math.min(1600, Math.max(256, 100 + expectedIds.length * 45)) : config.aiTextMaxTokens;
          const request: any = { id: ++report.actualHttpRequests, runId: run.id, model: choice.model, stage, startedAt: new Date().toISOString(), tokens: null, validJson: false, request: {
            model: choice.model, messages: [{ role: "system", content: system }, { role: "user", content: typeof content === "string" ? content : JSON.stringify(content) }], temperature: 0.1, max_tokens: maxTokens, stream: false, ...choice.parameters,
          } };
          report.requests.push(request);
          run.requests.push(request.id);
          await save();
          const start = Date.now();
          try {
            const response = await fetch(base + "/chat/completions", {
              method: "POST", headers: { authorization: "Bearer " + config.nvidiaKey, "content-type": "application/json" },
              body: JSON.stringify(request.request), signal: AbortSignal.timeout(45000),
            });
            request.status = response.status;
            request.headersMs = Date.now() - start;
            const raw = await response.text();
            request.latencyMs = Date.now() - start;
            try { request.rawResponse = JSON.parse(raw); } catch { request.rawBody = raw; }
            const body = request.rawResponse;
            request.tokens = Number.isFinite(body?.usage?.total_tokens) ? body.usage.total_tokens : null;
            request.finishReason = body?.choices?.[0]?.finish_reason;
            request.reasoningCharacters = String(body?.choices?.[0]?.message?.reasoning_content || body?.choices?.[0]?.message?.reasoning || "").length;
            if (!response.ok) throw Error("provider_http_" + response.status);
            if (request.finishReason === "length") throw Error("ai_output_limit");
            const text = String(body?.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, "");
            const parsed = JSON.parse(text);
            request.validJson = true;
            return parsed;
          } catch (error: any) {
            request.errorName = error.name;
            request.rawErrorCode = error.code;
            request.error = error.name === "TimeoutError" || error.name === "AbortError" ? "ai_timeout" : error.code || error.message || error.name;
            throw error;
          } finally {
            request.latencyMs = Date.now() - start;
            await save();
            console.log(JSON.stringify({ model: choice.model, stage, latencyMs: request.latencyMs, status: request.status, tokens: request.tokens, finishReason: request.finishReason, validJson: request.validJson, error: request.error }));
          }
        },
      };
      try {
        run.result = await grounded(llm, "請提供藥品用途、用法資訊、注意事項、警語、追問與小測驗。", source.chunks, {
          profile: { displayName: "虛構成人／研討會模型比較", age: 32, conditions: ["氣喘"] },
          medications: [{ id: "synthetic-med-" + source.licenseNo, name: source.licenseNo === "內衛成製字第000544號" ? "“新喜”酵素膠囊" : "“生達”咳服錠２００毫克（呱芬那辛）", licenseNo: source.licenseNo, doseAmount: 1, doseUnit: source.licenseNo === "內衛成製字第000544號" ? "粒" : "錠", frequencyRaw: source.licenseNo === "內衛成製字第000544號" ? "TID" : "PRN", confirmed: true, rawText: "合成測試，非真實處方" }],
        }, "bundle");
        Object.assign(run, validate(run.result, source));
      } catch (error: any) {
        run.errorName = error.name;
        run.rawErrorCode = error.code;
        run.error = error.name === "TimeoutError" || error.name === "AbortError" ? "ai_timeout" : error.code || error.message || error.name;
        run.passed = false;
      }
      run.latencyMs = Date.now() - started;
      const calls = report.requests.filter((r: any) => r.runId === run.id);
      run.tokensKnown = calls.length > 0 && calls.every((r: any) => r.tokens !== null);
      run.tokens = run.tokensKnown ? calls.reduce((sum: number, r: any) => sum + r.tokens, 0) : null;
      run.knownTokenSubtotal = calls.reduce((sum: number, r: any) => sum + (r.tokens ?? 0), 0);
      await save();
      console.log(JSON.stringify({ run: run.id, model: choice.model, repetition, licenseNo: source.licenseNo, passed: run.passed, latencyMs: run.latencyMs, claims: run.result?.claims.length, quiz: run.result?.quiz.length, rejected: run.result?.rejectedCount, error: run.error }));
    }
  }
}
report.summary = choices.map((choice) => {
  const runs = report.runs.filter((r: any) => r.model === choice.model);
  return { model: choice.model, passed: runs.filter((r: any) => r.passed).length, total: runs.length, latenciesMs: runs.map((r: any) => r.latencyMs), failures: runs.filter((r: any) => !r.passed).map((r: any) => ({ run: r.id, error: r.error, checks: r.checks })) };
});
report.completedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ reportPath, actualHttpRequests: report.actualHttpRequests, summary: report.summary }));
