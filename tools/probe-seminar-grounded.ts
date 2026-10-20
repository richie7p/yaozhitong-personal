/** Up to four real HTTP requests; only public sources and a synthetic adult. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { grounded, type Llm } from "../server/ai.js";
import { config } from "../server/config.js";
import type { Leaflet } from "../shared/schema.js";

const base = config.nvidiaBase.replace(/\/$/, "");
if (new URL(base).origin !== "https://integrate.api.nvidia.com" || !config.nvidiaKey)
  throw Error("An official NVIDIA endpoint and configured key are required.");
const review = JSON.parse(await readFile("data/leaflets/local-reviewed.json", "utf8"));
const { leaflets } = JSON.parse(await readFile(config.localPath + "/db.json", "utf8"));
const fixtures = review.items.map((reviewed: any) => Object.values<Leaflet>(leaflets).find((item) => item.licenseNo === reviewed.licenseNo && item.sha256 === reviewed.sha256));
if (fixtures.some((item: unknown) => !item)) throw Error("Reviewed fixture unavailable.");
const report: any = { createdAt: new Date().toISOString(), model: config.textModel, maxHttpRequests: 4, deadlineMs: 60000, actualHttpRequests: 0, syntheticPatient: true, mockedAI: false, requests: [], runs: [] };
const reportPath = ".local/reports/seminar-grounded-probes.json";
await mkdir(".local/reports", { recursive: true });
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const llm: Llm = {
  async json(system, content) {
    if (++report.actualHttpRequests > report.maxHttpRequests) throw Error("HTTP request budget exhausted.");
    const request: any = { id: report.actualHttpRequests, systemCharacters: system.length, contentCharacters: JSON.stringify(content).length, maxTokens: 4000 };
    report.requests.push(request);
    const start = Date.now();
    try {
      const response = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + config.nvidiaKey, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.textModel,
          messages: [{ role: "system", content: system }, { role: "user", content: typeof content === "string" ? content : JSON.stringify(content) }],
          temperature: 0.1,
          max_tokens: 4000,
          response_format: { type: "json_object" },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(60000),
      });
      request.status = response.status;
      request.headersMs = Date.now() - start;
      const responseText = await response.text();
      request.bodyMs = Date.now() - start;
      const data = JSON.parse(responseText);
      request.usage = data.usage;
      request.finishReason = data.choices?.[0]?.finish_reason;
      request.content = data.choices?.[0]?.message?.content;
      request.reasoningCharacters = String(data.choices?.[0]?.message?.reasoning_content || "").length;
      if (!response.ok) throw Error("Provider HTTP " + response.status);
      const value = JSON.parse(String(request.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*/, "").replace(/```$/, ""));
      request.validJson = true;
      await save();
      return value;
    } catch (error: any) {
      request.error = error.name;
      request.bodyMs = Date.now() - start;
      await save();
      throw error;
    } finally {
      console.log(JSON.stringify({ id: request.id, status: request.status, headersMs: request.headersMs, bodyMs: request.bodyMs, finishReason: request.finishReason, usage: request.usage, validJson: request.validJson, error: request.error }));
    }
  },
};
for (const leaflet of fixtures as Leaflet[]) {
  const run: any = { licenseNo: leaflet.licenseNo, sourceUrl: leaflet.sourceUrl, sha256: leaflet.sha256 };
  report.runs.push(run);
  const start = Date.now();
  try {
    run.result = await grounded(llm, "請依仿單整理本藥的用途與注意事項，並出一至兩題理解測驗。", leaflet.chunks, {
      profile: { displayName: "虛構成人／模型探測", age: 32, conditions: ["氣喘"] },
      medications: [{ name: leaflet.licenseNo === "內衛成製字第000544號" ? "酵素膠囊" : "咳嗽錠", licenseNo: leaflet.licenseNo, doseAmount: 1, doseUnit: leaflet.licenseNo === "內衛成製字第000544號" ? "粒" : "錠", frequencyRaw: "TID", confirmed: true, rawText: "虛構測試用法，不是真實處方" }],
    }, "bundle");
    run.passed = run.result.status === "supported" && run.result.claims.length > 0 && run.result.quiz.length > 0;
  } catch (error: any) { run.error = error.name; run.errorCode = error.code; run.passed = false; }
  run.latencyMs = Date.now() - start;
  await save();
  console.log(JSON.stringify({ licenseNo: run.licenseNo, passed: run.passed, latencyMs: run.latencyMs, error: run.error, errorCode: run.errorCode, claims: run.result?.claims?.length, quiz: run.result?.quiz?.length }));
}
report.completedAt = new Date().toISOString();
await save();
