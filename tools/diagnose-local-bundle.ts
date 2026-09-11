/** Opt-in real model diagnosis using official sources and synthetic context only. */
import { readFile, writeFile } from "node:fs/promises";
import { Nvidia, grounded } from "../server/ai.js";
const db = JSON.parse(await readFile(".local/db.json", "utf8"));
const l: any = Object.values(db.leaflets).find(
  (l: any) => l.licenseNo === "內衛成製字第000544號",
);
const llm = new Nvidia(),
  trace: any[] = [],
  start = Date.now();
const json = llm.json.bind(llm);
llm.json = async (...args) => {
  const output = await json(...args);
  trace.push({
    stage: trace.length === 0 ? "generation" : "verification",
    requestedClaims: (args[1] as any)?.claims?.length,
    output,
  });
  return output;
};
let result, error;
try {
  result = await grounded(
    llm,
    "請整理仿單白話說明、警語、追問與理解測驗。",
    l.chunks,
    {
      medications: [
        { licenseNo: l.licenseNo, name: "酵素膠囊", usage: "1 粒 TID" },
      ],
      profile: null,
    },
    "bundle",
  );
} catch (e: any) {
  error = e.code || "error";
}
const file = ".local/reports/bundle-diagnostic-" + Date.now() + ".json";
await writeFile(
  file,
  JSON.stringify(
    {
      syntheticContext: true,
      trace,
      result,
      error,
      latencyMs: Date.now() - start,
      tokens: llm.tokens,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    file,
    error,
    stages: trace.map((t) => ({
      stage: t.stage,
      requestedClaims: t.requestedClaims,
      outputType: Array.isArray(t.output) ? "array" : typeof t.output,
    })),
  }),
);
