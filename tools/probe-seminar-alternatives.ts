/** Exact synthetic production-message replays: at most 2 generation + 2 review calls. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { config } from "../server/config.js";
import { grounded, sourcePassages, type Llm } from "../server/ai.js";
import type { Leaflet } from "../shared/schema.js";

const runDirectory = ".local/seminar-flow-1792416844066";
const reportPath = ".local/reports/seminar-alternative-production-replay.json";
const base = config.nvidiaBase.replace(/\/$/, "");
if (new URL(base).origin !== "https://integrate.api.nvidia.com" || !config.nvidiaKey)
  throw Error("An official NVIDIA endpoint and configured key are required.");
const inventory = JSON.parse(await readFile(".local/reports/seminar-model-probes.json", "utf8"));
const choices = [
  {
    model: "google/diffusiongemma-26b-a4b-it",
    trace: "upstream-04.json",
    parameters: { chat_template_kwargs: { enable_thinking: false } },
    documentation: "https://docs.api.nvidia.com/nim/reference/diffusiongemma-26b-a4b-it-infer",
  },
  {
    model: "z-ai/glm-5.3-flash",
    trace: "upstream-05.json",
    parameters: { reasoning_effort: "low", chat_template_kwargs: { clear_thinking: true } },
    documentation: "https://build.nvidia.com/z-ai/glm-5-3-flash/modelcard",
  },
];
if (choices.some((choice) => !inventory.availableModels.includes(choice.model)))
  throw Error("A selected alternative is absent from the recorded authenticated inventory.");
const report: any = {
  createdAt: new Date().toISOString(),
  runDirectory,
  endpoint: base,
  syntheticPatient: true,
  mockedAI: false,
  deadlineMs: 45000,
  maximumGenerationRequests: 2,
  maximumVerificationRequests: 2,
  actualGenerationRequests: 0,
  actualVerificationRequests: 0,
  adaptations: "Original complete production messages, temperature and generation output budget retained. Original Nemotron-only kwargs and unconfirmed JSON-mode transport flag removed; official model-specific low-reasoning settings applied.",
  probes: [],
};
await mkdir(".local/reports", { recursive: true });
const redact = (value: unknown): string => {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of [config.nvidiaKey, config.openaiKey].filter(Boolean)) text = text.split(key).join("[redacted]");
  return text.replace(/account '[^']+'/g, "account '[redacted]'");
};
const save = () => writeFile(reportPath, redact(report));
async function request(model: string, stage: "generation" | "verification", payload: any) {
  if (stage === "generation" && ++report.actualGenerationRequests > 2) throw Error("Generation budget exhausted.");
  if (stage === "verification" && ++report.actualVerificationRequests > 2) throw Error("Verification budget exhausted.");
  const entry: any = { model, stage, request: payload, startedAt: new Date().toISOString() };
  const start = Date.now();
  try {
    const response = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + config.nvidiaKey, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });
    entry.status = response.status;
    entry.headersLatencyMs = Date.now() - start;
    const text = await response.text();
    entry.bodyLatencyMs = Date.now() - start;
    try { entry.rawResponse = JSON.parse(text); } catch { entry.rawBody = text; }
    entry.usage = entry.rawResponse?.usage;
    entry.finishReason = entry.rawResponse?.choices?.[0]?.finish_reason;
    entry.rawContent = entry.rawResponse?.choices?.[0]?.message?.content;
    entry.reasoningCharacters = String(entry.rawResponse?.choices?.[0]?.message?.reasoning_content || "").length;
    if (response.ok && entry.finishReason !== "length") {
      try {
        // Match production parsing exactly; no special repair of a candidate's output.
        entry.parsedJson = JSON.parse(String(entry.rawContent || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, ""));
        entry.validJson = true;
      } catch { entry.validJson = false; }
    }
  } catch (error: any) {
    entry.error = error.name;
    entry.bodyLatencyMs = Date.now() - start;
  }
  console.log(JSON.stringify({ model, stage, status: entry.status, headersMs: entry.headersLatencyMs, bodyMs: entry.bodyLatencyMs, finish: entry.finishReason, usage: entry.usage, validJson: entry.validJson, error: entry.error }));
  return entry;
}

const fixtures = (await Promise.all(choices.map(async (choice) => {
  const trace = JSON.parse(await readFile(runDirectory + "/" + choice.trace, "utf8"));
  if (trace.syntheticPatient !== true || trace.request?.messages?.length !== 2)
    throw Error("Only the known synthetic production trace may be replayed.");
  const original = trace.request;
  const { response_format: _responseFormat, chat_template_kwargs: _kwargs, ...retained } = original;
  const payload = { ...retained, model: choice.model, stream: false, ...choice.parameters };
  const entry = await request(choice.model, "generation", payload);
  const probe: any = { choice, generation: entry };
  report.probes.push(probe);
  await save();
  return { choice, original, probe };
})));

// Only this isolated acceptance run is loaded. It contains synthetic records and public leaflets.
const { leaflets } = JSON.parse(await readFile(runDirectory + "/db.json", "utf8"));
for (const { choice, original, probe } of fixtures) {
  if (!probe.generation.validJson) continue;
  const input = JSON.parse(original.messages[1].content);
  const license = input.context.medications[0].licenseNo;
  const leaflet = Object.values<Leaflet>(leaflets).find((item) => item.licenseNo === license);
  if (!leaflet) throw Error("Synthetic run leaflet fixture unavailable.");
  const sources = sourcePassages(leaflet.chunks);
  if (input.sources.some((item: any) => {
    const source = sources.find((source) => source.id === item.id);
    return !source || source.chunkId !== item.chunkId || source.quote.replace(/\s+/g, " ").trim() !== item.text;
  })) throw Error("Source mapping changed since the production trace; refusing cached-generation validation.");
  let cachedGenerationReturned = false;
  const llm: Llm = {
    async json(system, content) {
      if (!cachedGenerationReturned) {
        cachedGenerationReturned = true;
        return probe.generation.parsedJson;
      }
      const ids = (content as any)?.expectedIds;
      if (!Array.isArray(ids)) throw Error("Only a production semantic verification call is permitted.");
      const entry = await request(choice.model, "verification", {
        model: choice.model,
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(content) }],
        temperature: original.temperature,
        max_tokens: Math.min(1600, Math.max(256, 100 + ids.length * 45)),
        stream: false,
        ...choice.parameters,
      });
      probe.verification = entry;
      await save();
      if (!entry.validJson) throw Error("Alternative semantic verification did not return usable JSON.");
      return entry.parsedJson;
    },
  };
  const profile: any = {};
  for (const fact of input.profileFacts || []) {
    if (fact.field === "age") profile.age = Number(fact.value);
    else if (fact.field === "conditions") (profile.conditions ||= []).push(fact.value);
  }
  try {
    probe.groundedResult = await grounded(llm, input.question, leaflet.chunks, { ...input.context, profile }, "bundle");
    probe.passed = probe.groundedResult.status === "supported" && probe.groundedResult.claims.some((claim: any) => claim.category === "purpose") && probe.groundedResult.quiz.length >= 1;
  } catch (error: any) { probe.validationError = error.code || error.name; probe.passed = false; }
  await save();
  console.log(JSON.stringify({ model: choice.model, passed: probe.passed, status: probe.groundedResult?.status, claims: probe.groundedResult?.claims?.length, quiz: probe.groundedResult?.quiz?.length, validationError: probe.validationError }));
}
report.completedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ reportPath, actualGenerationRequests: report.actualGenerationRequests, actualVerificationRequests: report.actualVerificationRequests }));
