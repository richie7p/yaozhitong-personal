/**
 * Real seminar acceptance with synthetic patients and isolated persistence.
 * Default: prepare and validate local fixtures only (no server or AI call).
 * Explicit execution: tsx --env-file-if-exists=.env tools/check-seminar-flow.ts --run-real-ai
 * One recognition + two bundles. Both viewports reuse the same real results.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { aiConnection, aiModelRoute, config } from "../server/config.js";
import { GROUNDING_VERSION } from "../server/ai.js";
import { hash } from "../server/domain.js";
import { nextReviewedQuestion } from "./quiz-navigation.js";
import type {
  Drug,
  GroundedResult,
  Job,
  Leaflet,
  LearningRecord,
  Medication,
} from "../shared/schema.js";

const runReal = process.argv.includes("--run-real-ai");
const port = 5196;
const base = "http://127.0.0.1:" + port;
const directory = resolve(
  ".local/seminar-flow-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8),
);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const report: any = {
  createdAt: new Date().toISOString(),
  check: "seminar-real-ai-browser-flow",
  status: "blocked",
  statusScope:
    "Automated workflow and canonical citation checks only; independent semantic content review is tracked separately.",
  syntheticPatient: true,
  mockedAI: false,
  runRealAI: runReal,
  maxPaidJobs: 3,
  tokenReporting:
    "tokens sums only token usage explicitly reported by upstream responses; null means unavailable. jobReportedTokens preserves the application value, whose default zero is not proof of zero usage. Partial response usage may not cover timed-out requests.",
  viewportPolicy:
    "One real recognition and two real bundles are shared by desktop and 375px checks; no response stubbing or substitute AI content.",
  conditionPresentationPolicy:
    "A reviewed relevance label remains distinct from an exact source-term mention. A source mention must occur in the approved warning text and its own canonical citation, and the UI must explicitly direct the reader to the original conditions. It is not a substituted personalization verdict.",
  directory,
  promptVersion: GROUNDING_VERSION,
  appVersion: JSON.parse(await readFile("package.json", "utf8")).version,
  steps: [],
  jobs: [],
  browserErrors: [],
  requestFailures: [],
  screenshots: [],
};
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let token = "";
let originalDatabaseHash = "";
let sourceDatabaseFile = "";
const safeName = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

async function saveReport() {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
async function screenshot(name: string) {
  if (!page) return;
  const path = resolve(directory, safeName(name) + ".png");
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}
async function step<T>(name: string, action: (entry: any) => Promise<T>) {
  const entry: any = {
    step: name,
    passed: false,
    startedAt: new Date().toISOString(),
  };
  report.steps.push(entry);
  console.log("Checking " + name);
  const started = Date.now();
  try {
    const value = await action(entry);
    entry.passed = true;
    return value;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    await screenshot("failure-" + name).catch(() => {});
    return undefined;
  } finally {
    entry.elapsedMs = Date.now() - started;
    await saveReport();
  }
}
function dependentFailure(name: string, reason: string) {
  report.steps.push({ step: name, passed: false, blockedBy: reason });
}
async function call<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + "/api/v1" + path, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(`API ${path}: ${data.code}: ${data.message}`);
  return data as T;
}
async function uiJob(name: string, path: string, trigger: () => Promise<void>) {
  return step<Job>(name, async (entry) => {
    const previousTraces = new Set(await readdir(directory));
    const [response] = await Promise.all([
      page!.waitForResponse(
        (response) =>
          response.url() === base + "/api/v1" + path &&
          response.request().method() === "POST",
        { timeout: 15000 },
      ),
      trigger(),
    ]);
    const queued = await response.json();
    if (!response.ok())
      throw Error("Queue rejected: " + JSON.stringify(queued));
    entry.jobId = queued.jobId;
    const started = Date.now();
    let job: Job | undefined;
    while (Date.now() - started < 180000) {
      job = await call<Job>("/jobs/" + queued.jobId);
      if (job.status === "failed" || job.status === "succeeded") break;
      await sleep(750);
    }
    if (!job) throw Error("No queued job returned.");
    const rawJobFile = resolve(directory, "job-" + job.id + ".json");
    await writeFile(rawJobFile, JSON.stringify(job, null, 2));
    // The diagnostic clone reads in parallel with the real client. Give its file
    // write a bounded interval after the job settles, without delaying fetch.
    const expectedTraceCount = (job as Job & { aiRequests?: unknown[] })
      .aiRequests?.length;
    const traceDeadline = Date.now() + 5000;
    let upstreamTraceFiles: string[] = [];
    do {
      upstreamTraceFiles = (await readdir(directory))
        .filter(
          (name) =>
            name.startsWith("upstream-") &&
            name.endsWith(".json") &&
            !previousTraces.has(name),
        )
        .sort();
      if (
        expectedTraceCount === undefined ||
        upstreamTraceFiles.length >= expectedTraceCount
      )
        break;
      await sleep(50);
    } while (Date.now() < traceDeadline);
    const upstream = await Promise.all(
      upstreamTraceFiles.map(async (name) =>
        JSON.parse(await readFile(resolve(directory, name), "utf8")),
      ),
    );
    const usage = upstream.filter(
      (trace) => typeof trace.usage?.total_tokens === "number",
    );
    const usageKnown = usage.length > 0;
    const upstreamRoute = upstream.map((trace) => ({
      model: trace.request?.model ?? null,
      stage: trace.request?.messages?.some((message: any) => {
        if (message.role !== "user" || typeof message.content !== "string")
          return false;
        try {
          return Array.isArray(JSON.parse(message.content).expectedIds);
        } catch {
          return false;
        }
      })
        ? "verification"
        : job.kind === "recognition"
          ? "vision"
          : "generation",
      status: trace.status ?? null,
      latencyMs: trace.latencyMs ?? null,
      error: trace.error ?? null,
    }));
    const actualModels = [
      ...new Set(upstreamRoute.map((request) => request.model)),
    ];
    const aiRequests = (
      job as Job & { aiRequests?: Array<Record<string, any>> }
    ).aiRequests;
    const metricsTraceMatch =
      Array.isArray(aiRequests) &&
      aiRequests.length === upstreamRoute.length &&
      aiRequests.every(
        (metric, index) =>
          metric.model === upstreamRoute[index].model &&
          metric.stage === upstreamRoute[index].stage &&
          (metric.status ?? null) === upstreamRoute[index].status,
      );
    const reportedUsage = {
      jobReportedTokens: job.tokens ?? null,
      tokens: usageKnown
        ? usage.reduce((sum, trace) => sum + trace.usage.total_tokens, 0)
        : null,
      usageKnown,
      usageMayBeIncomplete:
        job.status !== "succeeded" ||
        upstream.some(
          (trace) =>
            trace.error ||
            trace.status < 200 ||
            trace.status >= 300 ||
            typeof trace.usage?.total_tokens !== "number",
        ),
      upstreamTraceFiles,
      upstreamRoute,
      actualModels,
      usedMultipleModels: actualModels.length > 1,
      fallbackUsed:
        aiRequests?.some((metric) => !!metric.fallbackFrom) || false,
      fallbackRequestCount:
        aiRequests?.filter((metric) => !!metric.fallbackFrom).length || 0,
      metricsTraceMatch,
      rawJobFile,
    };
    report.jobs.push({ ...job, ...reportedUsage });
    Object.assign(entry, {
      status: job.status,
      latencyMs: job.latencyMs ?? null,
      ...reportedUsage,
      attempts: job.attempts,
      errorCode: job.error?.code ?? null,
    });
    if (job.status !== "succeeded")
      throw Error(job.error?.code || "job_wait_timeout");
    expect(
      metricsTraceMatch,
      "Persisted per-request model, stage and status must agree with real upstream traces",
    ).toBe(true);
    return job;
  });
}
function assertSupported(result: GroundedResult, source: Leaflet) {
  expect(result.status).toBe("supported");
  expect(result.claims.length).toBeGreaterThan(0);
  expect(result.claims.some((claim) => claim.category === "purpose")).toBe(
    true,
  );
  expect(result.quiz.length).toBeGreaterThan(0);
  expect(result.sourceVersions[source.licenseNo]).toBe(source.version);
  for (const chunk of result.chunks) {
    const canonical = source.chunks.find(
      (candidate) => candidate.id === chunk.id,
    );
    expect(
      canonical,
      "Returned source chunks must exist in the fixed reviewed leaflet",
    ).toBeDefined();
    expect(
      chunk,
      "Returned source text, page, identity and offsets must match the canonical leaflet exactly",
    ).toEqual(canonical);
  }
  const citations = [
    ...result.claims.flatMap((c) => c.citations),
    ...result.quiz.flatMap((q) => q.citations),
  ];
  for (const claim of result.claims) {
    for (const mention of claim.sourceMentions || []) {
      expect(claim.category).toBe("warning");
      expect(mention.field).toBe("conditions");
      expect(mention.value).toBe("氣喘");
      const compact = (text: string) =>
        text.normalize("NFKC").replace(/\s/g, "");
      expect(compact(claim.text)).toContain(compact(mention.value));
      expect(
        claim.citations.some((citation) =>
          compact(citation.quote).includes(compact(mention.value)),
        ),
        "A source mention must be present in this approved claim's own quotation",
      ).toBe(true);
    }
  }
  for (const citation of citations) {
    const chunk = result.chunks.find((c) => c.id === citation.chunkId);
    expect(
      chunk,
      "A citation must resolve to a real source chunk",
    ).toBeDefined();
    expect(chunk!.licenseNo).toBe(source.licenseNo);
    expect(chunk!.version).toBe(source.version);
    const canonical = source.chunks.find(
      (candidate) => candidate.id === citation.chunkId,
    )!;
    const compact = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
    expect(
      compact(canonical.text),
      "Each quote must occur in the original reviewed source, not just a returned chunk",
    ).toContain(compact(citation.quote));
  }
  for (const question of result.quiz) {
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(question.answer)).toBe(true);
    expect(question.answer).toBeGreaterThanOrEqual(0);
    expect(question.answer).toBeLessThan(question.options.length);
    const normalizedOptions = question.options.map((option) =>
      option.normalize("NFKC").replace(/\s/g, ""),
    );
    expect(
      new Set(normalizedOptions).size,
      "Published quiz choices must be distinct before independent semantic review",
    ).toBe(question.options.length);
    expect(
      question.explanationKind,
      "Published explanations must be identified as original source text",
    ).toBe("source_quote");
    const heading =
      /^依仿單「(?:適應症|用途\(適應症\)|效能|警語|警語及注意事項|注意事項|使用上注意事項|副作用|副作用\/不良反應|附記|禁忌|禁忌症|交互作用|過量)」原文：/;
    expect(question.explain).toMatch(heading);
    const lines = question.explain
      .replace(heading, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const compact = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
    for (const line of lines)
      expect(
        question.citations.some((citation) =>
          compact(citation.quote).includes(compact(line)),
        ),
        "Each explanation line must occur in this question's own canonical citations",
      ).toBe(true);
  }
}
async function login() {
  await page!.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page!.getByRole("button", { name: "登出", exact: true }),
  ).toBeVisible();
}
async function showLearning(recordId: string) {
  await page!.goto(
    base +
      "/#learning?record=" +
      encodeURIComponent(recordId) +
      "&section=quiz",
  );
  await expect(
    page!.getByRole("heading", { name: "用藥小教室", exact: true }),
  ).toBeVisible();
  await expect(page!.locator(".learning-record")).toHaveCount(1);
  await expect(page!.locator(".learning-record")).toHaveAttribute(
    "data-learning-id",
    recordId,
  );
}

try {
  if (config.mode !== "local")
    throw Error("Use APP_MODE=local for isolated acceptance.");
  const provider = config.aiProvider;
  const connection = aiConnection();
  const endpoint = new URL(connection.base);
  const apiKey = connection.key;
  if (
    endpoint.origin !==
    (provider === "openai"
      ? "https://api.openai.com"
      : "https://integrate.api.nvidia.com")
  )
    throw Error(
      "Real acceptance requires an official NVIDIA or OpenAI HTTPS endpoint.",
    );
  Object.assign(report, {
    provider,
    endpoint: endpoint.origin,
    textModel: config.textModel,
    visionModel: config.visionModel,
    aiConfigured: !!apiKey,
    fallbackPolicy: {
      provider,
      textModels: aiModelRoute().slice(1),
      visionModels: aiModelRoute(true).slice(1),
      primaryTimeoutMs:
        provider === "nvidia" ? config.aiPrimaryTimeoutMs : null,
      textPrimaryTimeoutMs:
        provider === "nvidia" ? config.aiTextPrimaryTimeoutMs : null,
      requestTimeoutMs: config.aiRequestTimeoutMs,
      jobTimeoutMs: config.aiJobTimeoutMs,
    },
  });
  const review = JSON.parse(
    await readFile("data/leaflets/local-reviewed.json", "utf8"),
  );
  sourceDatabaseFile = resolve(config.localPath, "db.json");
  const originalDatabase = await readFile(sourceDatabaseFile);
  originalDatabaseHash = hash(originalDatabase);
  report.sourceDatabase = {
    path: sourceDatabaseFile,
    beforeSha256: originalDatabaseHash,
  };
  const source = JSON.parse(originalDatabase.toString("utf8"));
  const catalog: Drug[] = JSON.parse(
    await readFile(
      resolve(config.localPath, "blobs", source.settings.catalog.path),
      "utf8",
    ),
  );
  const drugs: Drug[] = [];
  const leaflets: Leaflet[] = [];
  for (const item of review.items) {
    const drug = catalog.find((d) => d.licenseNo === item.licenseNo);
    const leaflet = Object.values<Leaflet>(source.leaflets || {}).find(
      (l) =>
        l.licenseNo === item.licenseNo &&
        l.sha256 === item.sha256 &&
        l.version === item.version &&
        l.status === "published",
    );
    if (!drug || !leaflet)
      throw Error(
        "Prepare the two fixed reviewed local leaflets before acceptance.",
      );
    if (new URL(leaflet.sourceUrl).hostname !== "mcp.fda.gov.tw")
      throw Error("Fixture source is not the expected official FDA site.");
    const bytes = await readFile(
      resolve(config.localPath, "blobs", leaflet.storagePath),
    );
    if (hash(bytes) !== leaflet.sha256)
      throw Error("Reviewed PDF SHA-256 has changed.");
    const target = resolve(directory, "blobs", leaflet.storagePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    drugs.push(drug);
    leaflets.push(leaflet);
  }
  report.sources = leaflets;
  report.sourceReview = review;
  await mkdir(resolve(directory, "blobs/catalog"), { recursive: true });
  await writeFile(
    resolve(directory, "blobs/catalog/reviewed.json"),
    JSON.stringify(drugs),
  );
  await writeFile(
    resolve(directory, "db.json"),
    JSON.stringify({
      leaflets: Object.fromEntries(leaflets.map((l) => [l.id, l])),
      published: Object.fromEntries(
        leaflets.map((l) => [
          hash(l.licenseNo),
          { leafletId: l.id, version: l.version },
        ]),
      ),
      settings: {
        catalog: {
          version: "reviewed-seminar-acceptance",
          path: "catalog/reviewed.json",
        },
      },
    }),
  );
  report.steps.push({
    step: "isolated-reviewed-fixtures",
    passed: true,
    copiedPdfCount: leaflets.length,
  });
  if (!runReal) {
    report.status = "prepared";
    report.reason =
      "Explicit --run-real-ai is required to launch the server and call the configured provider.";
  } else {
    if (!apiKey)
      throw Error(
        "The selected AI provider has no configured API key; no model called.",
      );
    const checkPort = createServer();
    await new Promise<void>((done, reject) => {
      checkPort.once("error", reject);
      checkPort.listen(port, "127.0.0.1", () =>
        checkPort.close((error) => (error ? reject(error) : done())),
      );
    });
    let serverLog = "";
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("tools/trace-seminar-ai.mjs")).href,
        "dist/server/index.mjs",
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          APP_MODE: "local",
          NODE_ENV: "",
          PORT: String(port),
          LOCAL_DATA_PATH: directory,
          SEMINAR_AI_TRACE_DIR: directory,
        },
      },
    );
    child.stdout?.on("data", (data) => {
      serverLog += String(data);
    });
    child.stderr?.on("data", (data) => {
      serverLog += String(data);
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null)
        throw Error("Isolated server exited: " + serverLog);
      try {
        ready = (
          await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })
        ).ok;
      } catch {}
      if (ready) break;
      await sleep(250);
    }
    if (!ready)
      throw Error("Build first; isolated server did not become ready.");
    const runtime = await (await fetch(base + "/api/v1/config")).json();
    report.runtimeAI = {
      provider: runtime.aiProvider,
      providerLabel: runtime.aiProviderLabel,
      textModel: runtime.aiTextModel,
      visionModel: runtime.aiVisionModel,
      textFallbackModels: runtime.aiTextFallbackModels,
      visionFallbackModels: runtime.aiVisionFallbackModels,
      appVersion: runtime.appVersion,
    };
    expect(
      runtime.aiProvider,
      "Rebuild if runtime provider metadata is stale",
    ).toBe(provider);
    expect(
      runtime.aiTextModel,
      "Rebuild if runtime text model metadata is stale",
    ).toBe(config.textModel);
    expect(
      runtime.aiVisionModel,
      "Rebuild if runtime vision model metadata is stale",
    ).toBe(config.visionModel);
    expect(
      runtime.aiTextFallbackModels,
      "Rebuild if runtime effective text fallback metadata is stale",
    ).toEqual(aiModelRoute().slice(1));
    expect(
      runtime.aiVisionFallbackModels,
      "Rebuild if runtime effective vision fallback metadata is stale",
    ).toEqual(aiModelRoute(true).slice(1));
    token = (
      await (
        await fetch(base + "/api/v1/auth/local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uid: "local-owner" }),
        })
      ).json()
    ).token;
    await call("/me", "PUT", {
      displayName: "虛構成人／研討會驗收",
      age: 32,
      conditions: ["氣喘"],
    });
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => report.browserErrors.push(error.message));
    page.on("requestfailed", (request) =>
      report.requestFailures.push({
        url: request.url(),
        method: request.method(),
        error: request.failure()?.errorText,
      }),
    );
    const imagePage = await context.newPage();
    await imagePage.setViewportSize({ width: 1200, height: 900 });
    await imagePage.setContent(
      `<html lang="zh-Hant"><meta charset="utf-8"><style>body{font:30px Arial;background:white;color:black;padding:35px}h1{font-size:32px}section{border:2px solid #333;padding:20px;margin:25px 0}p{margin:14px 0}small{font-size:22px}</style><small>合成藥袋・軟體測試用途・非真實處方／無真實病人資料</small><section><h1>${escapeHtml(drugs[0].nameZh)}</h1><p>每次：1 粒　頻次：TID</p><p>途徑：口服　天數：7</p></section><section><h1>${escapeHtml(drugs[1].nameZh)}</h1><p>每次：1 錠　頻次：PRN</p><p>途徑：口服　需要時才服用</p></section></html>`,
    );
    const photo = resolve(directory, "synthetic-two-medication-bag.png");
    await imagePage.screenshot({ path: photo, fullPage: true });
    await imagePage.close();
    report.syntheticInput = {
      path: photo,
      sha256: hash(await readFile(photo)),
      expected: drugs.map((d, i) => ({
        licenseNo: d.licenseNo,
        name: d.nameZh,
        doseAmount: 1,
        doseUnit: i === 0 ? "粒" : "錠",
        frequencyRaw: i === 0 ? "TID" : "PRN",
      })),
    };
    await page.goto(base);
    await login();
    await page.goto(base + "/#add");
    await page.locator('input[type="file"]').setInputFiles(photo);
    const recognition = await uiJob(
      "real-ui-recognition",
      "/recognitions",
      () =>
        page!.getByRole("button", { name: "開始辨識", exact: true }).click(),
    );
    const confirmed: Medication[] = [];
    if (recognition) {
      const recognitionValid = await step(
        "recognition-fields-and-two-viewports",
        async () => {
          const result = recognition.result as any;
          expect(result.status).toBe("succeeded");
          expect(result.medications).toHaveLength(2);
          for (let i = 0; i < drugs.length; i++) {
            const recognized = result.medications.find((m: any) =>
              m.candidates?.some(
                (c: Drug) => c.licenseNo === drugs[i].licenseNo,
              ),
            );
            expect(
              recognized,
              "Each medicine must match the correct official candidate",
            ).toBeDefined();
            expect(recognized.doseAmount).toBe(1);
            expect(recognized.doseUnit).toBe(i === 0 ? "粒" : "錠");
            expect(recognized.frequencyRaw).toBe(i === 0 ? "TID" : "PRN");
          }
          await expect(
            page!.getByRole("button", { name: "編輯這筆資料", exact: true }),
          ).toHaveCount(2);
          for (const width of [1280, 375]) {
            await page!.setViewportSize({
              width,
              height: width === 375 ? 812 : 900,
            });
            expect(
              await page!.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            await screenshot(`${width}-recognition`);
          }
          return true;
        },
      );
      if (recognitionValid) {
        for (let i = 0; i < drugs.length; i++) {
          const drug = drugs[i];
          const medication = await step<Medication>(
            "human-confirm:" + drug.licenseNo,
            async (entry) => {
              await page!.setViewportSize({
                width: i === 0 ? 1280 : 375,
                height: i === 0 ? 900 : 812,
              });
              await page!
                .locator("button.search-result")
                .filter({ hasText: drug.licenseNo })
                .click();
              await expect(
                page!.getByLabel("藥品名稱", { exact: true }),
              ).toHaveValue(drug.nameZh);
              await expect(
                page!.getByLabel("許可證字號", { exact: true }),
              ).toHaveValue(drug.licenseNo);
              await expect(
                page!.getByLabel("每次劑量", { exact: true }),
              ).toHaveValue("1");
              await expect(
                page!.getByLabel("頻次原文", { exact: true }),
              ).toHaveValue(i === 0 ? "TID" : "PRN");
              await page!
                .getByLabel("需要時才使用（不排定時提醒）")
                .setChecked(i === 1);
              await page!.getByLabel("我已對照藥袋確認藥品與用法").check();
              await screenshot(`${i === 0 ? 1280 : 375}-human-confirm-${i}`);
              const recognizedIndex = (
                recognition.result as any
              ).medications.findIndex((row: any) =>
                row.candidates?.some(
                  (candidate: Drug) => candidate.licenseNo === drug.licenseNo,
                ),
              );
              expect(recognizedIndex).toBeGreaterThanOrEqual(0);
              const savePath = `/api/v1/recognitions/${encodeURIComponent(recognition.id)}/medications/${recognizedIndex}`;
              const [savedResponse] = await Promise.all([
                page!.waitForResponse(
                  (r) =>
                    r.url() === base + savePath &&
                    r.request().method() === "POST",
                ),
                page!
                  .getByRole("button", { name: "確認並儲存藥品", exact: true })
                  .click(),
              ]);
              const saved = await savedResponse.json();
              expect(savedResponse.ok()).toBe(true);
              expect(saved.confirmed).toBe(true);
              expect(saved.licenseNo).toBe(drug.licenseNo);
              expect(saved.prn).toBe(i === 1);
              entry.medicationId = saved.id;
              entry.recognitionIndex = recognizedIndex;
              entry.savedVia = savePath;
              if (i === 0)
                await expect(page!.getByText(/還有 1 筆待核對/)).toBeVisible();
              return saved as Medication;
            },
          );
          if (medication) confirmed.push(medication);
          if (medication && i === 0)
            await step(
              "resume-partially-confirmed-recognition-no-new-ai",
              async (entry) => {
                await page!.goto(base + "/#jobs");
                const resumeLink = page!.getByRole("link", {
                  name: "繼續核對辨識結果",
                  exact: true,
                });
                await expect(resumeLink).toHaveAttribute(
                  "href",
                  "#add?recognition=" + encodeURIComponent(recognition.id),
                );
                await resumeLink.click();
                await expect(
                  page!.getByRole("button", {
                    name: "編輯這筆資料",
                    exact: true,
                  }),
                ).toHaveCount(1);
                await expect(
                  page!
                    .locator("button.search-result")
                    .filter({ hasText: drugs[0].licenseNo }),
                ).toHaveCount(0);
                await expect(
                  page!
                    .locator("button.search-result")
                    .filter({ hasText: drugs[1].licenseNo }),
                ).toHaveCount(1);
                const jobs = (await call<{ items: Job[] }>("/jobs")).items;
                const saved = (
                  await call<{ items: Medication[] }>("/medications")
                ).items;
                expect(jobs).toHaveLength(1);
                expect(jobs[0].id).toBe(recognition.id);
                expect(saved).toHaveLength(1);
                expect(saved[0].id).toBe(medication.id);
                entry.recognitionJobId = recognition.id;
                entry.alreadySavedMedicationId = medication.id;
                entry.remainingRows = 1;
                await screenshot("recognition-resumed-one-row-remaining");
              },
            );
        }
      }
    }
    if (confirmed.length !== 2) {
      dependentFailure(
        "two-medication-confirmation",
        "recognition or human confirmation failed",
      );
      for (const drug of drugs) {
        dependentFailure(
          "real-ui-bundle:" + drug.licenseNo,
          "two-medication-confirmation",
        );
        for (const label of ["desktop", "mobile"])
          dependentFailure(
            label + ":quiz-source-and-persistence:" + drug.licenseNo,
            "two-medication-confirmation",
          );
      }
    } else {
      await step("reminder-and-prn-isolation", async (entry) => {
        await page!.goto(base + "/#medications");
        const enzyme = page!
          .locator(".med-card")
          .filter({ hasText: drugs[0].licenseNo });
        const cough = page!
          .locator(".med-card")
          .filter({ hasText: drugs[1].licenseNo });
        await expect(
          enzyme.getByText("用法已確認", { exact: true }),
        ).toBeVisible();
        await expect(
          cough.getByText("用法已確認", { exact: true }),
        ).toBeVisible();
        await expect(
          cough.getByRole("button", { name: "排定提醒", exact: true }),
        ).toHaveCount(0);
        await expect(
          cough.getByRole("button", { name: "記錄服用", exact: true }),
        ).toBeVisible();
        await enzyme
          .getByRole("button", { name: "排定提醒", exact: true })
          .click();
        await page!.getByLabel("每天提醒時間").fill("08:00, 13:00, 19:00");
        await page!
          .getByRole("button", { name: "確認提醒時間", exact: true })
          .click();
        await expect(
          page!.getByRole("button", { name: "確認提醒時間", exact: true }),
        ).toHaveCount(0);
        const schedules = (await call("/schedules")).items;
        expect(schedules).toHaveLength(1);
        expect(schedules[0].medicationId).toBe(confirmed[0].id);
        expect(schedules[0].times).toEqual(["08:00", "13:00", "19:00"]);
        entry.schedule = schedules[0];
        await screenshot("375-confirmed-medications-and-reminder");
      });
      for (let i = 0; i < confirmed.length; i++) {
        const medication = confirmed[i];
        await page.goto(base + "/#medications");
        await page.setViewportSize({ width: 1280, height: 900 });
        const bundle = await uiJob(
          "real-ui-bundle:" + medication.licenseNo,
          "/bundles",
          () =>
            page!
              .locator(".med-card")
              .filter({ hasText: medication.licenseNo! })
              .getByRole("button", { name: "仿單說明", exact: true })
              .click(),
        );
        if (bundle)
          await step(
            "bundle-source-validation:" + medication.licenseNo,
            async (entry) => {
              const result = bundle.result as GroundedResult;
              assertSupported(result, leaflets[i]);
              if (i === 0) {
                expect(
                  result.claims.some(
                    (c) => c.profileRefs?.length || c.sourceMentions?.length,
                  ),
                ).toBe(false);
              } else {
                const reviewedRelevance = result.claims.some((c) =>
                  c.profileRefs?.some(
                    (r) => r.field === "conditions" && r.value === "氣喘",
                  ),
                );
                const sourceTermMention = result.claims.some((c) =>
                  c.sourceMentions?.some(
                    (r) => r.field === "conditions" && r.value === "氣喘",
                  ),
                );
                expect(
                  reviewedRelevance || sourceTermMention,
                  "The approved asthma warning needs a reviewed relevance label or a clearly distinguished exact source-term mention",
                ).toBe(true);
                const panel = page!.locator(".evidence .personal-precautions");
                if (reviewedRelevance) {
                  await expect(
                    panel
                      .locator(".profile-reference:not(.source-mention)")
                      .filter({ hasText: "氣喘" })
                      .first(),
                  ).toContainText("參考你填寫的資料：");
                } else {
                  await expect(
                    panel
                      .locator(".source-mention")
                      .filter({ hasText: "氣喘" })
                      .first(),
                  ).toHaveText(
                    "仿單原文提到你填寫的「氣喘」；請對照原文中的適用條件。",
                  );
                }
                entry.conditionPresentation = {
                  reviewedRelevance,
                  sourceTermMention,
                  displayedAs: reviewedRelevance
                    ? "reviewed_relevance"
                    : "exact_source_term_mention",
                };
              }
              await expect(
                page!.locator(".evidence .confirmed-usage"),
              ).toContainText(medication.name);
              await expect(page!.locator(".evidence .quiz")).toBeVisible();
              await screenshot("1280-real-bundle-" + i);
            },
          );
      }
      const records = (await call<{ items: LearningRecord[] }>("/learning"))
        .items;
      report.generatedLearning = records;
      for (const [label, width, height] of [
        ["desktop", 1280, 900],
        ["mobile", 375, 812],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const medication of confirmed) {
          const row = records.find((r) =>
            r.medicationIds.includes(medication.id),
          );
          if (!row?.result.quiz.length) {
            dependentFailure(
              label + ":quiz:" + medication.licenseNo,
              "real bundle did not produce a usable quiz",
            );
            continue;
          }
          await step(
            label + ":quiz-source-and-persistence:" + medication.licenseNo,
            async (entry) => {
              await showLearning(row.id);
              const record = page!.locator(
                `.learning-record[data-learning-id="${row.id}"]`,
              );
              await expect(record).toContainText(medication.name);
              const quiz = record.locator(".quiz");
              const retry = quiz.getByRole("button", {
                name: "重新複習",
                exact: true,
              });
              if (await retry.count()) await retry.click();
              for (let qIndex = 0; qIndex < row.result.quiz.length; qIndex++) {
                const q = row.result.quiz[qIndex];
                await expect(quiz.locator("legend")).toContainText(q.q);
                const wrong = (q.answer + 1) % q.options.length;
                await quiz.getByRole("radio").nth(wrong).check();
                await quiz
                  .getByRole("button", { name: "檢查答案", exact: true })
                  .click();
                await expect(quiz.getByText(/再看一下：/)).toBeVisible();
                for (const citation of q.citations) {
                  await expect(
                    quiz
                      .locator(".quiz-feedback blockquote")
                      .filter({ hasText: citation.quote }),
                  ).toBeVisible();
                }
                if (qIndex === 0) {
                  await page!.reload();
                  await expect(
                    quiz.getByRole("radio").nth(wrong),
                  ).toBeChecked();
                  await page!
                    .getByRole("button", { name: "登出", exact: true })
                    .click();
                  await login();
                  await showLearning(row.id);
                  await expect(
                    quiz.getByRole("radio").nth(wrong),
                  ).toBeChecked();
                  const evidence = record
                    .getByText("對照仿單原文", { exact: true })
                    .first();
                  await evidence.focus();
                  await page!.keyboard.press("Enter");
                  await expect(
                    record.locator(".education-card blockquote").first(),
                  ).toBeVisible();
                }
                await quiz.scrollIntoViewIfNeeded();
                await screenshot(
                  `${label}-wrong-${safeName(medication.licenseNo!)}-${qIndex}`,
                );
                await quiz.getByRole("radio").nth(q.answer).focus();
                await page!.keyboard.press("Space");
                await quiz
                  .getByRole("button", { name: "檢查答案", exact: true })
                  .focus();
                await page!.keyboard.press("Enter");
                await expect(quiz.getByText(/^答對了。/)).toBeVisible();
                if (qIndex < row.result.quiz.length - 1) {
                  // On the second viewport later questions may already be correct.
                  // Reopen review if correcting this question completed the record.
                  await nextReviewedQuestion(quiz, qIndex);
                }
              }
              // A reviewed completed quiz stays in review mode until explicitly finished.
              const finish = quiz.getByRole("button", {
                name: "完成複習",
                exact: true,
              });
              if (await finish.count()) await finish.click();
              await expect(
                quiz.getByText("答對了。已完成測驗，進度已保存。", {
                  exact: true,
                }),
              ).toBeVisible();
              await page!.reload();
              await expect(
                quiz.getByText("答對了。已完成測驗，進度已保存。", {
                  exact: true,
                }),
              ).toBeVisible();
              await page!
                .getByRole("button", { name: "登出", exact: true })
                .click();
              await login();
              await showLearning(row.id);
              await expect(
                quiz.getByText("答對了。已完成測驗，進度已保存。", {
                  exact: true,
                }),
              ).toBeVisible();
              expect(
                await page!.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
              ).toBe(true);
              const saved = (
                await call<{ items: LearningRecord[] }>("/learning")
              ).items.find((r) => r.id === row.id)!;
              expect(saved.progress!.passed).toBe(true);
              expect(saved.progress!.correct).toBe(row.result.quiz.length);
              entry.progress = saved.progress;
              entry.answers = saved.answers;
              entry.checks = [
                "all-questions-wrong-source",
                "all-questions-correct",
                "keyboard-evidence-and-answer",
                "reload-wrong-and-correct",
                "logout-login-wrong-and-correct",
                "no-horizontal-overflow",
              ];
              await screenshot(
                label + "-completed-" + safeName(medication.licenseNo!),
              );
            },
          );
        }
      }
      await step(
        "persisted-medications-reminder-and-no-extra-ai",
        async (entry) => {
          const meds = (await call<{ items: Medication[] }>("/medications"))
            .items;
          const schedules = (await call("/schedules")).items;
          const jobs = (await call<{ items: Job[] }>("/jobs")).items;
          expect(meds).toHaveLength(2);
          expect(meds.map((m) => m.licenseNo).sort()).toEqual(
            drugs.map((d) => d.licenseNo).sort(),
          );
          expect(schedules).toHaveLength(1);
          expect(schedules[0].medicationId).toBe(confirmed[0].id);
          expect(jobs).toHaveLength(3);
          expect(jobs.filter((j) => j.kind === "recognition")).toHaveLength(1);
          expect(jobs.filter((j) => j.kind === "bundle")).toHaveLength(2);
          entry.jobs = jobs.map((j) => ({
            id: j.id,
            kind: j.kind,
            status: j.status,
          }));
          entry.savedMedications = meds;
          entry.savedSchedules = schedules;
        },
      );
    }
    report.browserRuntimeClean = report.browserErrors.length === 0;
    if (!report.browserRuntimeClean)
      dependentFailure("browser-runtime", "See browserErrors");
    await writeFile(resolve(directory, "server.log"), serverLog);
    report.status = report.steps.every((s: any) => s.passed)
      ? "passed"
      : "failed";
  }
} catch (error) {
  report.status = runReal ? "failed" : "blocked";
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  }
  if (originalDatabaseHash) {
    const afterHash = hash(await readFile(sourceDatabaseFile));
    report.sourceDatabase.afterSha256 = afterHash;
    report.sourceDatabase.unchanged = afterHash === originalDatabaseHash;
    if (afterHash !== originalDatabaseHash) {
      report.status = "failed";
      report.steps.push({
        step: "main-database-unchanged",
        passed: false,
        error:
          "The source database changed during acceptance; inspect external writers.",
      });
    }
  }
  const traces = (await readdir(directory).catch(() => [])).filter(
    (name) => name.startsWith("upstream-") && name.endsWith(".json"),
  );
  report.upstreamRequests = await Promise.all(
    traces.map(async (name) => {
      const trace = JSON.parse(
        await readFile(resolve(directory, name), "utf8"),
      );
      return {
        file: resolve(directory, name),
        sequence: trace.sequence,
        model: trace.request?.model,
        latencyMs: trace.latencyMs,
        status: trace.status ?? null,
        usage: trace.usage ?? null,
        finishReason: trace.finishReason ?? null,
        unreadableResponse: !!trace.unreadableResponse,
        error: trace.error ?? null,
      };
    }),
  );
  report.finishedAt = new Date().toISOString();
  report.workflowStatus = runReal ? report.status : "not_run";
  report.contentQaStatus =
    runReal && report.status === "passed" ? "pending" : "not_ready";
  report.overallStatus =
    runReal && report.status === "failed" ? "failed" : "pending";
  await saveReport();
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/seminar-real-ai-flow.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        workflowStatus: report.workflowStatus,
        contentQaStatus: report.contentQaStatus,
        overallStatus: report.overallStatus,
        report: resolve(directory, "report.json"),
        provider: report.provider,
        textModel: report.textModel,
        visionModel: report.visionModel,
        jobs: report.jobs.map((j: any) => ({
          kind: j.kind,
          status: j.status,
          latencyMs: j.latencyMs,
          tokens: j.tokens,
          usageKnown: j.usageKnown,
          jobReportedTokens: j.jobReportedTokens,
          error: j.error,
        })),
        failures: report.steps
          .filter((s: any) => !s.passed)
          .map((s: any) => ({
            step: s.step,
            error: s.error,
            blockedBy: s.blockedBy,
          })),
        error: report.error,
      },
      null,
      2,
    ),
  );
  if (!["passed", "prepared"].includes(report.status)) process.exitCode = 1;
}
