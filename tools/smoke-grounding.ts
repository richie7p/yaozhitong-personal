import { Nvidia, grounded, type Llm } from "../server/ai.js";
import { config } from "../server/config.js";
import { writeFile, mkdir } from "node:fs/promises";
const chunk = {
  id: "fixture-1",
  licenseNo: "TEST-NONMEDICAL",
  version: "synthetic-v1",
  page: 1,
  start: 0,
  text: "本測試資料只列出文件名稱與版本編號，不包含任何藥物劑量、交互作用、治療或安全性的資訊。",
};
const claim = {
  text: "這份文件證明同時服用兩種藥物很安全。",
  citations: [{ chunkId: chunk.id, quote: chunk.text }],
};
let first = true;
const n = new Nvidia();
const llm: Llm = {
  json: async (system, content) => {
    if (first) {
      first = false;
      return { status: "supported", claims: [claim], quiz: [], followups: [] };
    }
    const raw = await n.json(system, content);
    console.log(JSON.stringify({ syntheticVerifierOutput: raw }));
    return raw;
  },
};
const start = Date.now();
const r = await grounded(
  llm,
  "這份文件能否證明兩種藥物一起服用是安全的？",
  [chunk],
  {},
  "interaction",
);
const report = {
  model: config.textModel,
  case: "synthetic semantic contradiction with exact source quote",
  passed: r.claims.length === 0 && r.rejectedCount === 1,
  result: r.status,
  latencyMs: Date.now() - start,
  tokens: n.tokens,
  limitation: "單一合成案例，只確認驗證流程可執行，不代表醫療準確率。",
};
await mkdir(".local/reports", { recursive: true });
await writeFile(
  ".local/reports/nvidia-grounding.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
if (!report.passed) process.exitCode = 1;
