/** Fixed, isolated expanded acceptance. Preparation is the default; external AI is opt-in. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
import {
  compareRecognition,
  expandedManifestSchema,
  fixtureBlob,
  imageMediaType,
  validateGroundedSource,
  type ExpandedCase,
} from "./seminar-expanded-support.js";

const args = process.argv.slice(2);
const runReal = args.includes("--run-real-ai");
const manifestName = args.find((arg) => !arg.startsWith("--"));
if (args.some((arg) => arg.startsWith("--") && arg !== "--run-real-ai"))
  throw Error("Unknown expanded acceptance option.");
const directory = resolve(
  ".local/seminar-expanded-" +
    Date.now() +
    "-" +
    crypto.randomUUID().slice(0, 8),
);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const readJson = async (file: string) =>
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const writeJson = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value, null, 2));
const report: any = {
  check: "seminar-expanded-fixed-acceptance",
  createdAt: new Date().toISOString(),
  directory,
  runRealAI: runReal,
  status: "not_available",
  promptVersion: GROUNDING_VERSION,
  scope:
    "Isolated software and literal-source acceptance. Camera provenance is supplied evidence, not inferred from pixels. Independent semantic review remains separate.",
  denominatorPolicy:
    "All manifest attempts are fixed before execution; missing input/source and failed attempts remain recorded, with no replacement attempts.",
  safety: {
    mainDatabaseMutated: false,
    demonstrationServiceTouched: false,
    osReboot: false,
    syntheticProfile: true,
  },
  attempts: [],
  inputKinds: {},
  limitations: [
    "No finite test establishes an external-provider availability guarantee.",
    "Manual-medication cases do not count as photograph or OCR passes.",
  ],
};
await mkdir(directory, { recursive: true });
const save = () => writeJson(resolve(directory, "report.json"), report);
report.softwareEvidence = Object.fromEntries(
  await Promise.all(
    [
      "dist/server/index.mjs",
      "dist/web/index.html",
      "server/ai.ts",
      "server/catalog.ts",
      "server/config.ts",
      "tools/check-seminar-expanded.ts",
      "tools/seminar-expanded-support.ts",
      "tools/quiz-navigation.ts",
      "tools/trace-seminar-expanded.mjs",
    ].map(async (file) => [
      file,
      await readFile(file).then(
        (bytes) => ({ available: true, sha256: hash(bytes) }),
        () => ({ available: false, sha256: null }),
      ),
    ]),
  ),
);
await save();

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No isolated port.");
  const port = address.port;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  if (port === 8085) throw Error("The demonstration port is reserved.");
  return port;
}

async function runAttempt(
  entry: any,
  testCase: ExpandedCase,
  drugs: Drug[],
  leaflets: Leaflet[],
  profile: any,
  browser: Browser,
) {
  const target = entry.directory;
  const port = await availablePort();
  const base = "http://127.0.0.1:" + port;
  let child: ChildProcess | undefined;
  let page: Page | undefined;
  let token = "";
  let serverLog = "";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const screenshot = async (name: string) => {
    if (!page) return;
    const file = resolve(target, name.replace(/[^a-zA-Z0-9_-]/g, "_") + ".png");
    await page.screenshot({
      path: file,
      fullPage: true,
      animations: "disabled",
    });
    entry.screenshots.push(file);
  };
  const checkpoint = async () => {
    await writeJson(resolve(target, "report.json"), entry);
    await save();
  };
  const step = async <T>(
    name: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    const step: any = {
      step: name,
      passed: false,
      startedAt: new Date().toISOString(),
    };
    entry.steps.push(step);
    const start = Date.now();
    try {
      const value = await action();
      step.passed = true;
      return value;
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      await screenshot("failure-" + name).catch(() => {});
      return undefined;
    } finally {
      step.elapsedMs = Date.now() - start;
      await checkpoint();
    }
  };
  const call = async <T = any>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> => {
    const response = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(10000),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(`Local API ${path}: ${result.code || response.status}`);
    return result as T;
  };
  const jobFromUI = (
    name: string,
    route: string,
    trigger: () => Promise<void>,
  ) =>
    step<Job>(name, async () => {
      const before = new Set(await readdir(target));
      const [response] = await Promise.all([
        page!.waitForResponse(
          (response) =>
            response.url() === base + "/api/v1" + route &&
            response.request().method() === "POST",
          { timeout: 15000 },
        ),
        trigger(),
      ]);
      const queued = await response.json();
      if (!response.ok())
        throw Error("Queue rejected: " + (queued.code || response.status()));
      let job: Job | undefined;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        job = await call<Job>("/jobs/" + queued.jobId);
        if (["succeeded", "failed"].includes(job.status)) break;
        await sleep(500);
      }
      if (!job) throw Error("Queued job was not returned.");
      const rawJobFile = resolve(target, "job-" + job.id + ".json");
      await writeJson(rawJobFile, job);
      let traces: any[] = [];
      const traceDeadline = Date.now() + 5000;
      do {
        const names = (await readdir(target))
          .filter(
            (name) => /^upstream-.*\.json$/.test(name) && !before.has(name),
          )
          .sort();
        traces = await Promise.all(
          names.map(async (name) => ({
            file: resolve(target, name),
            ...(await readJson(resolve(target, name))),
          })),
        );
        if (traces.length >= (job.aiRequests?.length || 0)) break;
        await sleep(50);
      } while (Date.now() < traceDeadline);
      const traceStage = (trace: any) =>
        trace.request?.messages?.some((message: any) => {
          if (message.role !== "user" || typeof message.content !== "string")
            return false;
          try {
            return Array.isArray(JSON.parse(message.content).expectedIds);
          } catch {
            return false;
          }
        })
          ? "verification"
          : job!.kind === "recognition"
            ? "vision"
            : "generation";
      const metricsTraceMatch =
        Array.isArray(job.aiRequests) &&
        job.aiRequests.length === traces.length &&
        job.aiRequests.every(
          (metric, index) =>
            metric.model === traces[index].request?.model &&
            metric.stage === traceStage(traces[index]) &&
            (metric.status ?? null) === (traces[index].status ?? null),
        );
      const actualModelMatches =
        traces.length > 0 &&
        traces.every(
          (trace) =>
            !(trace.status >= 200 && trace.status < 300) ||
            trace.response?.model === "gpt-6-luna",
        );
      const summary = {
        ...job,
        rawJobFile,
        metricsTraceMatch,
        actualModelMatches,
        traces: traces.map((trace) => ({
          file: trace.file,
          requestModel: trace.request?.model ?? null,
          actualModel: trace.response?.model ?? null,
          stage: traceStage(trace),
          status: trace.status ?? null,
          usage: trace.usage ?? null,
          latencyMs: trace.latencyMs ?? null,
          error: trace.error ?? null,
        })),
        fallbackUsed:
          job.aiRequests?.some((metric) => !!metric.fallbackFrom) || false,
      };
      entry.jobs.push(summary);
      await checkpoint();
      expect(job.status, job.error?.code || "Job deadline").toBe("succeeded");
      expect(
        metricsTraceMatch,
        "Persisted metrics must match every upstream trace.",
      ).toBe(true);
      expect(
        actualModelMatches,
        "Every successful upstream response must identify GPT-6 Luna.",
      ).toBe(true);
      expect(summary.fallbackUsed).toBe(false);
      return job;
    });
  try {
    const buildHash = hash(await readFile("dist/server/index.mjs"));
    if (buildHash !== report.softwareEvidence["dist/server/index.mjs"].sha256)
      throw Error(
        "The compiled server changed during this fixed batch; no new case started.",
      );
    entry.compiledServerSha256 = buildHash;
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("tools/trace-seminar-expanded.mjs")).href,
        "dist/server/index.mjs",
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          APP_MODE: "local",
          SERVICE_ROLE: "web",
          NODE_ENV: "",
          PORT: String(port),
          LOCAL_DATA_PATH: target,
          SEMINAR_AI_TRACE_DIR: target,
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
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null)
        throw Error("Isolated server exited before readiness.");
      if (serverLog.includes(`藥智通 API http://127.0.0.1:${port} (local)`)) {
        try {
          ready = (
            await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })
          ).ok;
        } catch {}
      }
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw Error("Build first; isolated server was not ready.");
    const runtime = await call("/config");
    entry.runtime = {
      provider: runtime.aiProvider,
      textModel: runtime.aiTextModel,
      visionModel: runtime.aiVisionModel,
      textFallbackModels: runtime.aiTextFallbackModels,
      visionFallbackModels: runtime.aiVisionFallbackModels,
    };
    expect(entry.runtime).toEqual({
      provider: "openai",
      textModel: "gpt-6-luna",
      visionModel: "gpt-6-luna",
      textFallbackModels: [],
      visionFallbackModels: [],
    });
    token = (await call("/auth/local", "POST", { uid: "local-owner" })).token;
    await call("/me", "PUT", {
      displayName: "虛構成人／擴充軟體驗收",
      age: profile?.age || 32,
      conditions: profile?.conditions || [],
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => entry.browserErrors.push(error.message));
    await page.goto(base);
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "登出", exact: true }),
    ).toBeVisible();
    let recognition: Job | undefined;
    let recognitionMatches = false;
    if (!testCase.skipRecognition) {
      await page.goto(base + "/#add");
      await page.locator('input[type="file"]').setInputFiles(entry.image.path);
      recognition = await jobFromUI("recognition", "/recognitions", () =>
        page!.getByRole("button", { name: "開始辨識", exact: true }).click(),
      );
      if (recognition) {
        const comparison = await step(
          "literal-recognition-and-candidates",
          async () => {
            const result = recognition!.result as any;
            expect(result.status).toBe("succeeded");
            if (testCase.scope === "usage_review") {
              const compact = (s: string) => s.normalize("NFKC").replace(/\s/gu, "").toUpperCase();
              const row = result.medications.find((row: any) => row.name?.trim() &&
                compact(row.name + " " + row.rawText).includes(compact(testCase.reviewNameMustInclude!)));
              expect(row, "The visible drug name must remain readable.").toBeTruthy();
              for (const field of ["doseAmount", "doseUnit", "doseText", "frequencyRaw"])
                expect(row[field], "Conflicting usage must stay unconfirmed: " + field).toBeNull();
              expect([null, "外用"]).toContain(row.route);
              expect(row.durationDays === null || (row.durationDays === 1 && /1\s*日份/.test(row.rawText))).toBe(true);
              expect(row.confidence).toBe("low");
              expect(result.guidance).toMatch(/核對|確認/);
              expect((await call<{items: Medication[]}>("/medications")).items).toHaveLength(0);
              entry.usageReview = { passed: true, confirmedIdentity: false, guidance: result.guidance,
                doseAndFrequencyLeftBlank: true, route: row.route, durationDays: row.durationDays,
                conflictDetected: /矛盾|衝突/.test(result.guidance), medicationsCreated: 0 };
              await expect(page!.getByText(result.guidance, {exact: true})).toBeVisible();
              await page!.goto(base + "/#add?recognition=" + recognition!.id);
              await page!.reload();
              await expect(page!.getByText(result.guidance, {exact: true})).toBeVisible();
              expect((await call<{items: Medication[]}>("/medications")).items).toHaveLength(0);
            } else {
              entry.recognitionComparison = compareRecognition(result.medications, testCase.expected);
              expect(entry.recognitionComparison.passed,
                "Every manually supplied field and official identity must match.").toBe(true);
            }
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
              await screenshot("recognition-" + width);
            }
            return true;
          },
        );
        recognitionMatches = comparison === true;
      }
    }
    entry.photographStatus = testCase.skipRecognition
      ? "not_applicable_manual_medication"
      : recognitionMatches
        ? testCase.scope === "usage_review" ? "review_required_as_expected" : "passed"
        : "failed";
    const confirmed: Medication[] = [];
    if (
      testCase.scope === "full_flow" &&
      (testCase.skipRecognition || recognitionMatches)
    ) {
      for (const expected of testCase.expected) {
        const drug = drugs.find(
          (drug) => drug.licenseNo === expected.licenseNo,
        )!;
        const medication = await step<Medication>(
          "human-source-confirmation:" + expected.licenseNo,
          async () => {
            if (testCase.skipRecognition) {
              await page!.goto(base + "/#add");
              await page!
                .getByRole("button", { name: "搜尋藥名", exact: true })
                .click();
              await page!
                .getByLabel("搜尋藥名", { exact: true })
                .fill(expected.licenseNo);
              await page!
                .getByRole("button", { name: "搜尋", exact: true })
                .click();
            } else {
              await page!.goto(base + "/#add?recognition=" + recognition!.id);
            }
            await page!
              .locator("button.search-result")
              .filter({ hasText: expected.licenseNo })
              .click();
            await expect(
              page!.getByLabel("藥品名稱", { exact: true }),
            ).toHaveValue(drug.nameZh);
            await expect(
              page!.getByLabel("許可證字號", { exact: true }),
            ).toHaveValue(drug.licenseNo);
            if (expected.confirm) {
              await page!
                .getByLabel("每次劑量", { exact: true })
                .fill(
                  expected.confirm.doseAmount === null
                    ? ""
                    : String(expected.confirm.doseAmount),
                );
              await page!
                .getByLabel("劑量單位", { exact: true })
                .fill(expected.confirm.doseUnit);
              // The form clears competing dose text on numeric/unit edits.
              if (expected.confirm.doseText !== undefined)
                await page!
                  .getByLabel("每次用量原文（非數字用量時填寫）", {
                    exact: true,
                  })
                  .fill(expected.confirm.doseText);
              await page!
                .getByLabel("頻次原文", { exact: true })
                .fill(expected.confirm.frequencyRaw);
              if (expected.confirm.route !== undefined)
                await page!
                  .getByLabel("給藥途徑", { exact: true })
                  .fill(expected.confirm.route);
              if (expected.confirm.durationDays !== undefined)
                await page!
                  .getByLabel("療程天數（可留白）", { exact: true })
                  .fill(
                    expected.confirm.durationDays === null
                      ? ""
                      : String(expected.confirm.durationDays),
                  );
              await page!
                .getByLabel("需要時才使用（不排定時提醒）")
                .setChecked(expected.confirm.prn);
            }
            await page!.getByLabel("我已對照藥袋確認藥品與用法").check();
            const recognizedIndex = testCase.skipRecognition
              ? -1
              : (recognition!.result as any).medications.findIndex((row: any) =>
                  row.candidates?.some(
                    (candidate: Drug) =>
                      candidate.licenseNo === expected.licenseNo,
                  ),
                );
            const route = testCase.skipRecognition
              ? "/medications"
              : `/recognitions/${recognition!.id}/medications/${recognizedIndex}`;
            const [response] = await Promise.all([
              page!.waitForResponse(
                (response) =>
                  response.url() === base + "/api/v1" + route &&
                  response.request().method() === "POST",
              ),
              page!
                .getByRole("button", { name: "確認並儲存藥品", exact: true })
                .click(),
            ]);
            const saved = await response.json();
            expect(response.ok()).toBe(true);
            expect(saved.confirmed).toBe(true);
            expect(saved.licenseNo).toBe(expected.licenseNo);
            return saved as Medication;
          },
        );
        if (medication) confirmed.push(medication);
      }
      for (const medication of confirmed) {
        await page.goto(base + "/#medications");
        const bundle = await jobFromUI(
          "bundle:" + medication.licenseNo,
          "/bundles",
          () =>
            page!
              .locator(".med-card")
              .filter({ hasText: medication.licenseNo! })
              .getByRole("button", { name: "仿單說明", exact: true })
              .click(),
        );
        if (bundle)
          await step("canonical-source:" + medication.licenseNo, async () => {
            const result = bundle.result as GroundedResult;
            const validation = validateGroundedSource(
              result,
              leaflets.find(
                (source) => source.licenseNo === medication.licenseNo,
              )!,
              testCase.expected.find(expected => expected.licenseNo === medication.licenseNo)?.requiredSafety,
            );
            entry.sourceValidation.push({
              licenseNo: medication.licenseNo,
              ...validation,
            });
            expect(validation.passed).toBe(true);
            await expect(
              page!.locator(".evidence .confirmed-usage"),
            ).toContainText(medication.name);
            await expect(page!.locator(".evidence .quiz")).toBeVisible();
            await screenshot("bundle-" + confirmed.indexOf(medication));
          });
      }
      const records = (await call<{ items: LearningRecord[] }>("/learning"))
        .items;
      entry.generatedLearning = records;
      for (const [label, width, height] of [
        ["desktop", 1280, 900],
        ["mobile", 375, 812],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const medication of confirmed) {
          const row = records.find((record) =>
            record.medicationIds.includes(medication.id),
          );
          if (!row?.result.quiz.length) {
            entry.steps.push({
              step: label + ":quiz:" + medication.licenseNo,
              passed: false,
              blockedBy: "No usable generated quiz",
            });
            continue;
          }
          await step(
            label + ":wrong-source-correct-reload:" + medication.licenseNo,
            async () => {
              await page!.goto(base + "/#learning");
              const record = page!
                .locator(".learning-record")
                .filter({ hasText: medication.name });
              const quiz = record.locator(".quiz");
              const review = quiz.getByRole("button", {
                name: "重新複習",
                exact: true,
              });
              if (await review.count()) await review.click();
              for (let index = 0; index < row.result.quiz.length; index++) {
                const question = row.result.quiz[index];
                await expect(quiz.locator("legend")).toContainText(question.q);
                const wrong = (question.answer + 1) % question.options.length;
                await quiz.getByRole("radio").nth(wrong).check();
                await quiz
                  .getByRole("button", { name: "檢查答案", exact: true })
                  .click();
                await expect(quiz.getByText(/再看一下：/)).toBeVisible();
                await expect(
                  quiz.locator(".quiz-feedback blockquote"),
                ).toHaveCount(question.citations.length);
                for (const [
                  quoteIndex,
                  citation,
                ] of question.citations.entries())
                  await expect(
                    quiz.locator(".quiz-feedback blockquote").nth(quoteIndex),
                  ).toContainText(citation.quote);
                await page!.reload();
                await expect(quiz.getByRole("radio").nth(wrong)).toBeChecked();
                await expect(quiz.locator("legend")).toContainText(question.q);
                const original = record
                  .getByText("對照仿單原文", { exact: true })
                  .first();
                await original.focus();
                await page!.keyboard.press("Enter");
                await expect(
                  record.locator(".education-card blockquote").first(),
                ).toBeVisible();
                await screenshot(
                  label +
                    "-wrong-" +
                    confirmed.indexOf(medication) +
                    "-" +
                    index,
                );
                await quiz.getByRole("radio").nth(question.answer).focus();
                await page!.keyboard.press("Space");
                await quiz
                  .getByRole("button", { name: "檢查答案", exact: true })
                  .click();
                await expect(quiz.getByText(/^答對了。/)).toBeVisible();
                if (index < row.result.quiz.length - 1) {
                  await nextReviewedQuestion(quiz, index);
                }
              }
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
              const live = (
                await call<{ items: LearningRecord[] }>("/learning")
              ).items.find((record) => record.id === row.id)!;
              expect(live.progress?.passed).toBe(true);
              expect(live.progress?.correct).toBe(row.result.quiz.length);
              expect(
                await page!.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
              ).toBe(true);
              await screenshot(
                label + "-completed-" + confirmed.indexOf(medication),
              );
            },
          );
        }
      }
    }
    const expectedJobs =
      (testCase.skipRecognition ? 0 : 1) +
      (testCase.scope === "full_flow" ? testCase.expected.length : 0);
    entry.expectedLogicalJobs = expectedJobs;
    entry.actualLogicalJobs = (
      await call<{ items: Job[] }>("/jobs")
    ).items.length;
    entry.dependentJobsNotCreated = Math.max(
      0,
      expectedJobs - entry.actualLogicalJobs,
    );
    if (entry.dependentJobsNotCreated > 0)
      entry.steps.push({
        step: "all-planned-jobs-created",
        passed: false,
        missing: entry.dependentJobsNotCreated,
      });
    expect(entry.actualLogicalJobs).toBeLessThanOrEqual(expectedJobs);
    if (entry.browserErrors.length)
      entry.steps.push({
        step: "browser-runtime",
        passed: false,
        errors: entry.browserErrors,
      });
    entry.status = entry.steps.every((step: any) => step.passed)
      ? "passed"
      : "failed";
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close();
    if (child && child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    await writeFile(resolve(target, "server.log"), serverLog);
    entry.finishedAt = new Date().toISOString();
    entry.workflowStatus = entry.status;
    entry.contentQaStatus =
      entry.status === "passed" && testCase.scope === "full_flow"
        ? "pending_independent_review"
        : "not_ready";
    await checkpoint();
  }
}

let browser: Browser | undefined;
let sourceDatabase = "";
let beforeDatabaseHash = "";
try {
  if (!manifestName) {
    report.reason =
      "Supply a manifest path. No photographs or additional source fixtures were supplied; no AI called.";
  } else {
    const manifestFile = resolve(manifestName);
    const manifest = expandedManifestSchema.parse(await readJson(manifestFile));
    const manifestRoot = dirname(manifestFile);
    report.manifest = {
      path: manifestFile,
      sha256: hash(await readFile(manifestFile)),
      contents: manifest,
    };
    sourceDatabase = resolve(manifestRoot, manifest.fixture.database);
    const blobRoot = resolve(manifestRoot, manifest.fixture.blobs);
    const sourceBytes = await readFile(sourceDatabase);
    beforeDatabaseHash = hash(sourceBytes);
    report.sourceDatabase = {
      path: sourceDatabase,
      beforeSha256: beforeDatabaseHash,
    };
    const source = JSON.parse(sourceBytes.toString("utf8"));
    const catalog: Drug[] = await readJson(
      fixtureBlob(blobRoot, source.settings.catalog.path),
    );
    const canonicalLeaflets = Object.values<Leaflet>(source.leaflets || {});
    const copiedBytes = new Map<string, Buffer>();
    for (const testCase of manifest.cases) {
      report.inputKinds[testCase.inputKind] =
        (report.inputKinds[testCase.inputKind] || 0) + testCase.repeat;
      for (let repeat = 1; repeat <= testCase.repeat; repeat++) {
        const target = resolve(directory, testCase.id + "-" + repeat);
        await mkdir(target, { recursive: true });
        const entry: any = {
          id: testCase.id,
          repeat,
          inputKind: testCase.inputKind,
          skipRecognition: testCase.skipRecognition,
          scope: testCase.scope,
          provenance: testCase.provenance,
          directory: target,
          status: "prepared",
          steps: [],
          jobs: [],
          sourceValidation: [],
          screenshots: [],
          browserErrors: [],
          notAvailableReasons: [],
        };
        report.attempts.push(entry);
        if (!testCase.skipRecognition) {
          if (!testCase.image)
            entry.notAvailableReasons.push(
              testCase.notAvailableReason || "Photograph not supplied.",
            );
          else {
            try {
              const imageFile = resolve(manifestRoot, testCase.image);
              const bytes = await readFile(imageFile);
              if (testCase.imageSha256 && hash(bytes) !== testCase.imageSha256)
                throw Error(
                  "Original photograph hash differs from the fixed manifest evidence.",
                );
              const mediaType = imageMediaType(bytes);
              const targetFile = resolve(
                target,
                "input" + (mediaType === "image/png" ? ".png" : ".jpg"),
              );
              await writeFile(targetFile, bytes);
              entry.image = {
                path: targetFile,
                originalPath: imageFile,
                sha256: hash(bytes),
                bytes: bytes.length,
                mediaType,
              };
            } catch (error) {
              entry.notAvailableReasons.push(
                "Image unavailable: " +
                  (error instanceof Error ? error.message : String(error)),
              );
            }
          }
        }
        const drugs: Drug[] = [];
        const leaflets: Leaflet[] = [];
        for (const expected of testCase.expected) {
          const drug = catalog.find(
            (drug) => drug.licenseNo === expected.licenseNo,
          );
          if (!drug) {
            entry.notAvailableReasons.push(
              "Official catalog drug missing: " + expected.licenseNo,
            );
            continue;
          }
          drugs.push(drug);
          if (testCase.skipRecognition && !expected.confirm)
            entry.notAvailableReasons.push(
              "Manual medication requires explicitly transcribed confirmation values: " +
                expected.licenseNo,
            );
          if (testCase.scope === "recognition") continue;
          const selected = source.published?.[hash(expected.licenseNo)];
          const leaflet = canonicalLeaflets.find(
            (leaflet) =>
              leaflet.licenseNo === expected.licenseNo &&
              leaflet.status === "published" &&
              leaflet.id === selected?.leafletId &&
              leaflet.version === selected?.version,
          );
          if (!leaflet) {
            entry.notAvailableReasons.push(
              "Published official source missing: " + expected.licenseNo,
            );
            continue;
          }
          try {
            const url = new URL(leaflet.sourceUrl);
            if (
              url.protocol !== "https:" ||
              !["mcp.fda.gov.tw", "info.fda.gov.tw"].includes(url.hostname)
            )
              throw Error("Source is not a supported official FDA HTTPS URL.");
            const bytes =
              copiedBytes.get(leaflet.storagePath) ||
              (await readFile(fixtureBlob(blobRoot, leaflet.storagePath)));
            if (hash(bytes) !== leaflet.sha256)
              throw Error("Official source bytes hash changed.");
            copiedBytes.set(leaflet.storagePath, bytes);
            const file = fixtureBlob(
              resolve(target, "blobs"),
              leaflet.storagePath,
            );
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, bytes);
            leaflets.push(leaflet);
          } catch (error) {
            entry.notAvailableReasons.push(
              "Source unavailable for " +
                expected.licenseNo +
                ": " +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        }
        entry.sources = leaflets;
        entry.expected = testCase.expected;
        entry.catalogCount = catalog.length;
        entry.plannedLogicalJobs =
          (testCase.skipRecognition ? 0 : 1) +
          (testCase.scope === "full_flow" ? testCase.expected.length : 0);
        await mkdir(resolve(target, "blobs/catalog"), { recursive: true });
        await writeJson(
          resolve(target, "blobs/catalog/expanded.json"),
          catalog,
        );
        await writeJson(resolve(target, "db.json"), {
          leaflets: Object.fromEntries(
            leaflets.map((leaflet) => [leaflet.id, leaflet]),
          ),
          published: Object.fromEntries(
            leaflets.map((leaflet) => [
              hash(leaflet.licenseNo),
              { leafletId: leaflet.id, version: leaflet.version },
            ]),
          ),
          settings: {
            catalog: {
              version: "expanded-fixed-acceptance",
              path: "catalog/expanded.json",
            },
          },
        });
        if (entry.notAvailableReasons.length) entry.status = "not_available";
        entry.drugs = drugs;
        await writeJson(resolve(target, "report.json"), entry);
      }
    }
    report.fixedAttempts = report.attempts.length;
    report.maxPaidLogicalJobs = report.attempts
      .filter((entry: any) => entry.status === "prepared")
      .reduce((sum: number, entry: any) => sum + entry.plannedLogicalJobs, 0);
    report.provider = config.aiProvider;
    report.models = { text: config.textModel, vision: config.visionModel };
    if (
      runReal &&
      report.attempts.some((entry: any) => entry.status === "prepared")
    ) {
      const connection = aiConnection();
      if (
        config.mode !== "local" ||
        config.aiProvider !== "openai" ||
        config.textModel !== "gpt-6-luna" ||
        config.visionModel !== "gpt-6-luna" ||
        new URL(connection.base).origin !== "https://api.openai.com" ||
        aiModelRoute().length !== 1 ||
        aiModelRoute(true).length !== 1 ||
        !connection.key
      )
        throw Error(
          "Real expanded acceptance requires local mode, the official OpenAI endpoint, a configured key and GPT-6 Luna without fallback; no AI called.",
        );
      browser = await chromium.launch();
      for (const entry of report.attempts) {
        if (entry.status !== "prepared") continue;
        console.log(
          "Expanded acceptance " +
            entry.id +
            " repeat " +
            entry.repeat +
            " (" +
            entry.inputKind +
            ")",
        );
        const testCase = manifest.cases.find(
          (testCase) => testCase.id === entry.id,
        )!;
        await runAttempt(
          entry,
          testCase,
          entry.drugs,
          entry.sources,
          manifest.profile,
          browser,
        );
      }
    }
    const passed = report.attempts.filter(
      (entry: any) => entry.status === "passed",
    ).length;
    const failed = report.attempts.filter(
      (entry: any) => entry.status === "failed",
    ).length;
    const unavailable = report.attempts.filter(
      (entry: any) => entry.status === "not_available",
    ).length;
    const photoAttempts = report.attempts.filter((entry: any) =>
      ["real_photo", "public_photo"].includes(entry.inputKind),
    );
    report.totals = {
      planned: report.attempts.length,
      passed,
      failed,
      notAvailable: unavailable,
      notRun: report.attempts.length - passed - failed - unavailable,
      attemptedCameraPhotographRuns: photoAttempts.filter(
        (entry: any) =>
          entry.photographStatus === "passed" ||
          entry.photographStatus === "failed" ||
          entry.photographStatus === "review_required_as_expected",
      ).length,
      actualCameraPhotographPassed: photoAttempts.filter(
        (entry: any) => entry.photographStatus === "passed" && entry.status === "passed",
      ).length,
      literalCameraRecognitionPassed: photoAttempts.filter(
        (entry: any) => entry.photographStatus === "passed",
      ).length,
      usageReviewPhotoPassed: photoAttempts.filter(
        (entry: any) => entry.photographStatus === "review_required_as_expected",
      ).length,
      manualMedicationAttempts: report.attempts.filter(
        (entry: any) => entry.skipRecognition,
      ).length,
      plannedCameraPhotographAttempts: photoAttempts.length,
      availableCameraPhotographAttempts: photoAttempts.filter(
        (entry: any) => !!entry.image,
      ).length,
    };
    const traces = report.attempts.flatMap((entry: any) =>
      entry.jobs.flatMap((job: any) => job.traces),
    );
    const sumKnown = (get: (trace: any) => unknown) => {
      const values = traces
        .map(get)
        .filter((value: unknown): value is number => typeof value === "number");
      return {
        known: values.length,
        total: values.length
          ? values.reduce((sum: number, value: number) => sum + value, 0)
          : null,
      };
    };
    report.usage = {
      upstreamRequests: traces.length,
      input: sumKnown((trace) => trace.usage?.prompt_tokens),
      output: sumKnown((trace) => trace.usage?.completion_tokens),
      total: sumKnown((trace) => trace.usage?.total_tokens),
      cached: sumKnown(
        (trace) => trace.usage?.prompt_tokens_details?.cached_tokens,
      ),
      cacheWrite: sumKnown(
        (trace) => trace.usage?.prompt_tokens_details?.cache_write_tokens,
      ),
      reasoning: sumKnown(
        (trace) => trace.usage?.completion_tokens_details?.reasoning_tokens,
      ),
      note: "Unknown fields remain null. Usage may be incomplete on failed requests; this is not the provider invoice.",
    };
    report.status = failed
      ? "failed"
      : unavailable
        ? "incomplete_not_available"
        : runReal && passed === report.attempts.length
          ? "passed_pending_independent_content_review"
          : "prepared";
  }
} catch (error) {
  report.status = "blocked";
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close();
  if (!report.totals) {
    const photoAttempts = report.attempts.filter((entry: any) =>
      ["real_photo", "public_photo"].includes(entry.inputKind),
    );
    report.totals = {
      planned: report.attempts.length,
      passed: report.attempts.filter((entry: any) => entry.status === "passed")
        .length,
      failed: report.attempts.filter((entry: any) => entry.status === "failed")
        .length,
      notAvailable: report.attempts.filter(
        (entry: any) => entry.status === "not_available",
      ).length,
      notRun: report.attempts.filter(
        (entry: any) => entry.status === "prepared",
      ).length,
      plannedCameraPhotographAttempts: photoAttempts.length,
      availableCameraPhotographAttempts: photoAttempts.filter(
        (entry: any) => !!entry.image,
      ).length,
      actualCameraPhotographPassed: photoAttempts.filter(
        (entry: any) => entry.photographStatus === "passed" && entry.status === "passed",
      ).length,
      literalCameraRecognitionPassed: photoAttempts.filter(
        (entry: any) => entry.photographStatus === "passed",
      ).length,
      manualMedicationAttempts: report.attempts.filter(
        (entry: any) => entry.skipRecognition,
      ).length,
    };
  }
  if (sourceDatabase && beforeDatabaseHash) {
    const after = hash(await readFile(sourceDatabase));
    report.sourceDatabase.afterSha256 = after;
    report.sourceDatabase.unchanged = after === beforeDatabaseHash;
    if (after !== beforeDatabaseHash) {
      report.status = "failed";
      report.safety.mainDatabaseMutated =
        "Source changed during acceptance; inspect external writers.";
    }
  }
  report.finishedAt = new Date().toISOString();
  await save();
  await mkdir(resolve(".local/reports"), { recursive: true });
  await writeJson(resolve(".local/reports/seminar-expanded.json"), report);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        report: resolve(directory, "report.json"),
        totals: report.totals,
        maxPaidLogicalJobs: report.maxPaidLogicalJobs,
        error: report.error,
      },
      null,
      2,
    ),
  );
  if (
    !["prepared", "passed_pending_independent_content_review"].includes(
      report.status,
    )
  )
    process.exitCode = 1;
}
