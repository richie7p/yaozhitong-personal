import { Nvidia } from "../server/ai.js";
import { config } from "../server/config.js";
import { mkdir, writeFile } from "node:fs/promises";
const start = Date.now();
let result: Record<string, unknown>;
try {
  const n = new Nvidia();
  const output = await n.json(
    '只回 JSON {"ok":true,"language":"繁體中文"}。',
    "這是連線測試，不包含使用者健康資料。",
  );
  if ((output as any)?.ok !== true || (output as any)?.language !== "繁體中文")
    throw Error(
      "JSON fields or Traditional Chinese output did not match the smoke fixture.",
    );
  result = {
    status: "passed",
    model: config.textModel,
    latencyMs: Date.now() - start,
    tokens: n.tokens,
    output,
  };
} catch (e: any) {
  result = {
    status: "failed",
    model: config.textModel,
    latencyMs: Date.now() - start,
    code: e.code || "error",
    message: e.message,
  };
  process.exitCode = 1;
}
await mkdir(".local/reports", { recursive: true });
await writeFile(
  ".local/reports/nvidia-smoke.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
