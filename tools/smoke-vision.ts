import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Nvidia, recognize } from "../server/ai.js";
import { config } from "../server/config.js";
const fixtures = JSON.parse(
  await readFile(".local/evaluation/images.json", "utf8"),
);
const sample = fixtures[Number(process.argv[2] || 2) - 1];
if (!sample?.synthetic || sample.split !== "development")
  throw Error(
    "Smoke tests require a synthetic development fixture; preserve the holdout set.",
  );
await mkdir(".local/reports", { recursive: true });
const start = Date.now();
let result: any;
try {
  const n = new Nvidia();
  const output = await recognize(
    n,
    await readFile(".local/evaluation/" + sample.file),
    "image/png",
  );
  const comparison = Object.fromEntries(
    Object.entries(sample.expectedFields).map(([key, expected]) => [
      key,
      {
        expected,
        actual: (output.medications[0] as any)?.[key] ?? null,
        match: (output.medications[0] as any)?.[key] === expected,
      },
    ]),
  );
  const passed =
    output.status === "succeeded" &&
    Object.values(comparison).every((x) => x.match);
  result = {
    status: passed ? "passed" : "failed",
    model: config.visionModel,
    fixture: sample.id,
    synthetic: true,
    latencyMs: Date.now() - start,
    tokens: n.tokens,
    comparison,
    output,
    limitation: "單一合成圖片不代表真實藥袋準確率。",
  };
  if (!passed) process.exitCode = 1;
} catch (e: any) {
  result = {
    status: "failed",
    model: config.visionModel,
    code: e.code,
    message: e.message,
    latencyMs: Date.now() - start,
  };
  process.exitCode = 1;
}
await writeFile(
  ".local/reports/nvidia-vision.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
