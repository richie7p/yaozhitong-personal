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
const quote =
  "注意事項：本文件完全為合成資料，僅供軟體流程測試，不可作為用藥依據。合成情境A的讀者應閱讀說明；未記載不能判斷安全。";
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
  try {
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
      if (Array.isArray(p.teachingFields) && !Array.isArray(p.sources))
        // This legacy synthetic provider intentionally has no additional
        // full-field lesson. Exercise safe partial preservation on repair.
        result = { fieldTeaching: [] };
      else if (Array.isArray(p.expectedIds))
        result = {
          verdicts: p.expectedIds.map((id: string) => ({
            id,
            supported: true,
          })),
        };
      else if (body.messages[0].content.includes("證據審核器"))
        result = {
          verdicts: p.claims.map((c: any) => ({ id: c.id, supported: true })),
        };
      else if (
        p.question.includes("測試一次失敗") &&
        !failures.has(p.question)
      ) {
        failures.add(p.question);
        result = "malformed";
      } else {
        const citations = p.sources
          .slice(0, 6)
          .map((s: any) => ({ sourceId: s.id }));
        result = {
          status: "supported",
          claims: [
            {
              text: "這份合成文件用於軟體流程測試。",
              category: "purpose",
              citations,
            },
            {
              text: "此文件只供軟體測試，不能用來決定用藥。",
              kind: "warning",
              category: "warning",
              profileRefs: p.profileFacts?.filter(
                (f: any) => f.field === "conditions" && f.value === "合成情境A",
              ),
              citations,
            },
            {
              text: "一般提醒：未記載不能判斷安全。",
              category: "warning",
              citations,
            },
            {
              text: "一般提醒：合成情境A的讀者應閱讀說明。",
              category: "warning",
              citations,
            },
            {
              text: "完整提醒：這份資料不可作為用藥依據。",
              category: "warning",
              citations,
            },
          ],
          quiz:
            p.kind === "bundle"
              ? [
                  {
                    claimIndex: 1,
                    learningObjective: "warning",
                    sourceSection: "注意事項",
                    requiredConditions: ["合成情境A的讀者"],
                    q: "依注意事項，合成情境A的讀者應閱讀說明；這份文件可用來決定用藥嗎？",
                    options: ["不可以，只供軟體測試", "可以"],
                    answer: 0,
                    explain:
                      "依注意事項，合成情境A的讀者應閱讀說明；原文指出不可作為用藥依據。",
                    citations,
                  },
                  {
                    claimIndex: 2,
                    learningObjective: "warning",
                    sourceSection: "注意事項",
                    requiredConditions: ["合成情境A的讀者"],
                    q: "依注意事項，合成情境A的讀者應閱讀說明；沒有記載就能判斷安全嗎？",
                    options: ["不可以，需確認資料", "可以直接判定安全"],
                    answer: 0,
                    explain:
                      "依注意事項，合成情境A的讀者應閱讀說明；原文指出未記載不能判斷安全。",
                    citations,
                  },
                ]
              : [],
          followups:
            p.kind === "bundle"
              ? [{ question: "這份資料的使用限制？", claimIndex: 1 }]
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
  } catch {
    // A malformed synthetic request should fail that AI job rather than bring
    // down the isolated app and turn unrelated tests into connection failures.
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Unsupported synthetic provider request" },
      }),
    );
  }
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
config.nvidiaBase = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
config.aiProvider = "nvidia";
config.nvidiaKey = "isolated-test-only";
config.userLimit = 100;
await import("../../server/index.js");
