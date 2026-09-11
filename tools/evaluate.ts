import { readFile, writeFile } from "node:fs/promises";
import { citationsValid } from "../server/ai.js";
const [file, out = "evaluation-report.json"] = process.argv.slice(2);
if (!file)
  throw Error("Usage: npm run evaluate -- predictions.jsonl report.json");
const rows = (await readFile(file, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((s) => JSON.parse(s));
const known = rows.filter((r) => r.expectedLicenseNo);
const fields = rows.flatMap((r) =>
  Object.entries(r.expectedFields || {}).map(([key, value]) => ({
    correct: r.predictedFields?.[key] === value,
  })),
);
const claims = rows.flatMap((r) =>
  (r.claims || []).map((c: any) => ({
    literal: citationsValid(c, r.chunks || []),
    humanSupported: c.humanSupported,
  })),
);
const judged = claims.filter((c) => typeof c.humanSupported === "boolean");
const latencies = rows
  .map((r) => r.latencyMs)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);
const report = {
  cases: rows.length,
  answeredCases: rows.filter((r) => r.claims?.length).length,
  failedCases: rows.filter((r) => r.error || r.status === "failed").length,
  top1: known.length
    ? known.filter((r) => r.candidates?.[0] === r.expectedLicenseNo).length /
      known.length
    : null,
  top3: known.length
    ? known.filter((r) =>
        r.candidates?.slice(0, 3).includes(r.expectedLicenseNo),
      ).length / known.length
    : null,
  fieldAccuracy: fields.length
    ? fields.filter((f) => f.correct).length / fields.length
    : null,
  literalCitationPassRate: claims.length
    ? claims.filter((c) => c.literal).length / claims.length
    : null,
  humanJudgedClaims: judged.length,
  unsupportedClaimRate: judged.length
    ? judged.filter((c) => !c.humanSupported).length / judged.length
    : null,
  p50LatencyMs: latencies.length
    ? latencies[Math.floor(latencies.length * 0.5)]
    : null,
  p95LatencyMs: latencies.length
    ? latencies[
        Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
      ]
    : null,
  totalTokens: rows.reduce((n, r) => n + (r.tokens || 0), 0),
  limitations: "原文吻合率不是語意正確率；缺人工標註時不推算無依據陳述比例。",
};
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
