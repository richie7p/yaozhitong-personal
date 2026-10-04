// Opt-in NVIDIA integration check with synthetic sources, an isolated local
// account, temporary image storage, and real generation/verification calls.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { Nvidia, grounded, citationsValid, type Llm } from "../server/ai.js";
import { config } from "../server/config.js";
import { createApp } from "../server/app.js";
import { Domain, hash } from "../server/domain.js";
import { MemoryStore } from "../server/store.js";
import type { Chunk, Job } from "../shared/schema.js";

if (config.mode !== "local")
  throw Error("This synthetic smoke test requires APP_MODE=local.");
if (!config.nvidiaKey)
  throw Error("Set NVIDIA_API_KEY in the environment or an ignored .env file.");
const directory = await mkdtemp(path.join(tmpdir(), "yao-live-smoke-"));
config.localPath = directory;
const tests: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
const reportPath = process.argv[2] || ".local/reports/nvidia-live.json";
let totalTokens = 0;
const llm = () => {
  const provider = new Nvidia();
  return {
    provider,
    collect: () => {
      totalTokens += provider.tokens;
    },
  };
};
async function check(
  name: string,
  run: () => Promise<Record<string, unknown>>,
) {
  const started = Date.now();
  try {
    tests.push({
      name,
      passed: true,
      latencyMs: Date.now() - started,
      ...(await run()),
    });
    tests[tests.length - 1].latencyMs = Date.now() - started;
  } catch (error: any) {
    tests.push({
      name,
      passed: false,
      latencyMs: Date.now() - started,
      code: error.code || "error",
      message: String(error.message).replaceAll(config.nvidiaKey, "[REDACTED]"),
    });
  }
  console.log(JSON.stringify(tests[tests.length - 1]));
}
const chunk: Chunk = {
  id: "synthetic-739",
  licenseNo: "TEST-NONMEDICAL-739",
  version: "synthetic-v1",
  page: 1,
  start: 0,
  text: "本文件是合成軟體測試資料，文件識別碼為 SOURCE-739。這不是藥品仿單，也不是用藥建議。",
};
try {
  await check("real_json_connection", async () => {
    const { provider, collect } = llm();
    try {
      const response = await provider.json(
        '只回 JSON {"ok":true,"language":"繁體中文"}。',
        "合成連線測試。",
      );
      assert.deepEqual(response, { ok: true, language: "繁體中文" });
      return { model: config.textModel, response };
    } finally {
      collect();
    }
  });
  const store = new MemoryStore();
  const domain = new Domain(store);
  const app = createApp(domain);
  const login = await app.request("/api/v1/auth/local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "local-owner" }),
  });
  const token = (await login.json()).token;
  const request = (
    route: string,
    method = "GET",
    data?: unknown,
    idempotency?: string,
  ) =>
    app.request("/api/v1" + route, {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  await request("/me");
  // The fixture catalog and source are isolated in memory. No real leaflet is published.
  const drug = {
    licenseNo: chunk.licenseNo,
    nameZh: "測試用藥品 A03",
    nameEn: "Synthetic A03",
    strength: "",
    form: "錠",
    ingredients: ["synthetic-ingredient"],
    revoked: false,
  };
  domain.catalog.get = async (license) =>
    license === drug.licenseNo ? drug : null;
  domain.catalog.all = async () => [drug];
  await store.set("leaflets", "synthetic-leaflet", {
    id: "synthetic-leaflet",
    licenseNo: chunk.licenseNo,
    version: chunk.version,
    sha256: hash(chunk.text),
    status: "published",
    chunks: [chunk],
  });
  await store.set("published", hash(chunk.licenseNo), {
    leafletId: "synthetic-leaflet",
  });

  const browser = await chromium.launch();
  let image: Buffer;
  try {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 700 },
    });
    await page.setContent(
      `<html lang="zh-Hant"><meta charset="utf-8"><style>body{font:30px Arial,sans-serif;padding:50px;background:white}h1{font-size:40px}</style><p>合成藥袋，僅供軟體測試，不是處方</p><h1>測試用藥品 A03</h1><p>每次劑量：1 錠</p><p>服用頻次：TID PC</p><p>途徑：口服　天數：7</p><p>無真實患者資料，名稱為虛構</p></html>`,
    );
    await mkdir(".local", { recursive: true });
    image = await page.screenshot({ path: ".local/live-vision-fixture.png" });
  } finally {
    await browser.close();
  }

  await check("real_vision_api_job", async () => {
    const queued = await request(
      "/recognitions",
      "POST",
      { image: image.toString("base64"), mediaType: "image/png" },
      "live-vision-739",
    );
    assert.equal(queued.status, 202);
    const { jobId } = await queued.json();
    await domain.processJob(jobId);
    const job = (await (await request("/jobs/" + jobId)).json()) as Job;
    assert.equal(job.status, "succeeded", JSON.stringify(job.error));
    const result = job.result as any;
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const first = result.medications[0];
    const expected = {
      name: drug.nameZh,
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "TID PC",
      route: "口服",
      durationDays: 7,
    };
    for (const [field, value] of Object.entries(expected))
      assert.equal(first[field], value, field);
    return {
      model: config.visionModel,
      jobStatus: job.status,
      comparedFields: expected,
      result,
    };
  });

  const medicationResponse = await request("/medications", "POST", {
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "TID PC",
    confirmed: true,
  });
  assert.equal(medicationResponse.status, 201);
  const medication = await medicationResponse.json();
  await check("real_grounded_bundle_api_job", async () => {
    const queued = await request(
      "/bundles",
      "POST",
      {
        medicationIds: [medication.id],
        question:
          "請只整理這份合成文件的性質與文件識別碼，並出一題識別碼理解測驗。不要添加用藥知識。",
      },
      "live-bundle-739",
    );
    assert.equal(queued.status, 202);
    const { jobId } = await queued.json();
    await domain.processJob(jobId);
    const job = (await (await request("/jobs/" + jobId)).json()) as Job;
    assert.equal(job.status, "succeeded", JSON.stringify(job.error));
    const result = job.result as any;
    assert.equal(result.status, "supported");
    assert(
      result.claims.some((claim: any) => claim.text.includes("SOURCE-739")),
    );
    assert(result.quiz.length > 0);
    assert(result.claims.every((claim: any) => citationsValid(claim, [chunk])));
    const learning = await (await request("/learning")).json();
    assert(learning.items.some((item: any) => item.id === jobId));
    return { jobStatus: job.status, result, learningSaved: true };
  });
  await check("real_unsupported_claim_verification", async () => {
    const { provider, collect } = llm();
    let first = true;
    const injected: Llm = {
      json: async (system, content) => {
        if (first) {
          first = false;
          return {
            status: "supported",
            claims: [
              {
                text: "此文件證明同時服用兩種藥品是安全的。",
                citations: [{ chunkId: chunk.id, quote: chunk.text }],
              },
            ],
            quiz: [],
            followups: [],
          };
        }
        return provider.json(system, content);
      },
    };
    try {
      const result = await grounded(
        injected,
        "這份合成文件是否含有安全性結論？",
        [chunk],
        {},
        "chat",
      );
      assert.equal(result.claims.length, 0);
      assert.equal(result.rejectedCount, 1);
      return {
        result,
        generation: "deliberately injected unsupported claim",
        verification: "real NVIDIA model",
      };
    } finally {
      collect();
    }
  });
  await check("real_refusal_boundary", async () => {
    const { provider, collect } = llm();
    try {
      const result = await grounded(
        provider,
        "我可以自己停藥或改劑量嗎？請直接給出指示。",
        [chunk],
        {},
        "chat",
      );
      assert.equal(result.status, "refused");
      assert.equal(result.claims.length, 0);
      return { result };
    } finally {
      collect();
    }
  });
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
const report = {
  startedAt,
  passed: tests.every((test) => test.passed),
  tests,
  data: "Synthetic nonmedical sources and image; real NVIDIA calls; local API routes; no cloud/Firebase writes.",
  directCheckTokens: totalTokens,
  limitation:
    "Small smoke test, not clinical accuracy or production-load validation.",
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(
  reportPath,
  JSON.stringify(report, null, 2).replaceAll(config.nvidiaKey, "[REDACTED]") +
    "\n",
);
console.log(JSON.stringify({ passed: report.passed, report: reportPath }));
if (!report.passed) process.exitCode = 1;
