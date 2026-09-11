/** Isolated browser-test upstream. Never imported by the deployed application. */
import { createServer } from "node:http";
import { config } from "../../server/config.js";
import { MemoryStore } from "../../server/store.js";
import { Blobs } from "../../server/blobs.js";
import { hash } from "../../server/domain.js";
import type { Drug, Chunk } from "../../shared/schema.js";
if (config.mode !== "local" || !config.localPath.includes("e2e-run-"))
  throw Error("Browser fixtures require an isolated local test directory");
const store = await new MemoryStore(config.localPath + "/db.json").load();
const drugs: Drug[] = [5, 10].map((n) => ({
  licenseNo: `SYNTHETIC-E2E-${n}`,
  nameZh: `流程測試片 ${n}mg`,
  nameEn: `Test tablet ${n}mg`,
  strength: `${n}mg`,
  form: "錠",
  ingredients: ["synthetic-only"],
  revoked: false,
}));
const quote = "本文件完全為合成資料，僅供軟體流程測試，不可作為用藥依據。";
for (const drug of drugs) {
  const c: Chunk = {
    id: drug.licenseNo + "-p1",
    licenseNo: drug.licenseNo,
    version: "fixture-v1",
    page: 1,
    start: 0,
    text: quote,
  };
  await store.set("leaflets", drug.licenseNo, {
    id: drug.licenseNo,
    licenseNo: drug.licenseNo,
    version: c.version,
    sha256: "synthetic",
    chunks: [c],
    status: "published",
    sourceUrl: "https://example.invalid/synthetic",
    checkedBy: "automated-fixture",
    checkedAt: new Date().toISOString(),
  });
  await store.set("published", hash(drug.licenseNo), {
    leafletId: drug.licenseNo,
    version: c.version,
  });
}
await new Blobs().put(
  "catalog/e2e.json",
  Buffer.from(JSON.stringify(drugs)),
  "application/json",
);
await store.set("settings", "catalog", {
  version: "e2e-v1",
  path: "catalog/e2e.json",
});
const failures = new Set<string>();
const upstream = createServer(async (req, res) => {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p);
  const body = JSON.parse(Buffer.concat(parts).toString());
  const input = body.messages[1].content;
  let result: unknown;
  if (Array.isArray(input))
    result = {
      status: "succeeded",
      medications: [
        {
          name: "流程測試片 5mg",
          strength: "5mg",
          form: "錠",
          doseAmount: null,
          doseUnit: null,
          frequencyRaw: null,
          route: "口服",
          durationDays: 7,
          rawText: "合成藥袋：流程測試片 5mg；劑量及頻次空白；口服；7天",
          confidence: "medium",
        },
      ],
    };
  else {
    const p = JSON.parse(input);
    if (body.messages[0].content.includes("證據審核器"))
      result = { verdicts: p.claims.map((c: any) => ({ id: c.id, supported: true })) };
    else if (p.question.includes("測試一次失敗") && !failures.has(p.question)) {
      failures.add(p.question);
      result = "malformed";
    } else {
      const citations = [{ chunkId: p.chunks[0].id, quote }];
      result = {
        status: "supported",
        claims: [
          {
            text: "此文件只供軟體測試，不能用來決定用藥。",
            kind: "warning",
            citations,
          },
        ],
        quiz:
          p.kind === "bundle"
            ? [
                {
                  q: "這份文件可用來決定用藥嗎？",
                  options: ["不可以，只供軟體測試", "可以"],
                  answer: 0,
                  explain: "原文指出不可作為用藥依據。",
                  citations,
                },
              ]
            : [],
        followups:
          p.kind === "bundle"
            ? [{ question: "這份資料的使用限制？", claimIndex: 0 }]
            : [],
      };
    }
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              result === "malformed" ? "{broken" : JSON.stringify(result),
          },
        },
      ],
      usage: { total_tokens: 1 },
    }),
  );
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
config.nvidiaBase = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
config.nvidiaKey = "isolated-test-only";
config.userLimit = 100;
await import("../../server/index.js");
