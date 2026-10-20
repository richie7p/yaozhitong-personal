/** Saved-results UI check after a service restart; never claims a Windows reboot. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { config } from "../server/config.js";

// Usage: tsx --env-file-if-exists=.env tools/check-seminar-saved-demo.ts .local/seminar-demo-... 8085 [prior-launcher.json]
const directory = resolve(process.argv[2] || "");
const directoryRelative = relative(resolve(".local"), directory).replaceAll(
  "\\",
  "/",
);
if (
  isAbsolute(directoryRelative) ||
  !/^seminar-demo-[\w-]+$/.test(directoryRelative)
)
  throw Error(
    "Use an isolated seminar-demo-* directory directly inside .local.",
  );
const port = Number(process.argv[3] || 8085);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid demonstration port.");
const priorLauncherFile = process.argv[4]
  ? resolve(process.argv[4])
  : undefined;
const base = "http://127.0.0.1:" + port;
const reportFile = resolve(".local/reports/seminar-saved-demo-ui.json");
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value: any) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const sorted = (items: any[]) =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));
const keys = [
  "medications",
  "learning",
  "generated",
  "jobs",
  "profiles",
  "leaflets",
  "published",
];
const protectedData = (db: any) =>
  Object.fromEntries(keys.map((key) => [key, db[key] || {}]));
const collectionHashes = (db: any) =>
  Object.fromEntries(keys.map((key) => [key, digest(db[key] || {})]));
const answerHash = (db: any) =>
  digest(
    Object.fromEntries(
      Object.entries(db.learning || {}).map(([id, row]) => [
        id,
        (row as any).answers,
      ]),
    ),
  );
const learningFields = (items: any[]) =>
  sorted(
    items.map((row) => ({
      id: row.id,
      medicationIds: row.medicationIds,
      result: row.result,
      answers: row.answers,
      groundingVersion: row.groundingVersion,
    })),
  );
const jobFields = (items: any[]) =>
  sorted(
    items
      .filter((job) => job.kind !== "delete-account")
      .map(({ input, ...publicJob }) => publicJob),
  );
const norm = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
const readJson = async (file: string) =>
  JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const report: any = {
  startedAt: new Date().toISOString(),
  check: "seminar-saved-results-browser-flow",
  scope: "service-restart",
  osRebootVerified: false,
  scopeNote:
    "Verifies launcher identity, optional prior/new service process evidence and saved UI results. This does not re-test or overwrite the separate Windows reboot evidence.",
  directory,
  base,
  realAiCalls: 0,
  generatedAiJobs: 0,
  steps: [],
  browserErrors: [],
  unexpectedAiRequests: [],
  screenshots: [],
};
await mkdir(resolve(".local/reports"), { recursive: true });
const save = () => writeFile(reportFile, JSON.stringify(report, null, 2));
await save();
let browser: Browser | undefined;
let page: Page | undefined;
let token = "";
let before: any;
let rows: any[] = [];
let meds: any[] = [];
const headers = () => ({
  authorization: "Bearer " + token,
  "content-type": "application/json",
});
const api = async (path: string, method = "GET", body?: unknown) => {
  // Only local sign-in, saved-state reads and quiz answer writes are permitted.
  if (
    method !== "GET" &&
    !(
      method === "POST" &&
      (path === "/auth/local" || /^\/learning\/[^/]+\/answers$/.test(path))
    )
  )
    throw Error("This saved-results check cannot enqueue or retry AI work.");
  const response = await fetch(base + "/api/v1" + path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error(
      "Saved demonstration API failed: " + path + " HTTP " + response.status,
    );
  return response.json();
};
async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  const entry: any = {
    step: name,
    passed: false,
    startedAt: new Date().toISOString(),
  };
  report.steps.push(entry);
  const start = Date.now();
  try {
    const value = await action();
    entry.passed = true;
    return value;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    entry.elapsedMs = Date.now() - start;
    await save();
  }
}
async function screenshot(name: string) {
  if (!page) return;
  const path = join(directory, "saved-demo-" + name + ".png");
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  report.screenshots.push(path);
}
try {
  const launcher = await step(
    "launcher-process-port-and-dataset-identity",
    async () => {
      const marker = await readJson(
        resolve(`.local/launcher/server-${port}.json`),
      );
      if (
        resolve(marker.dataPath).toLowerCase() !== directory.toLowerCase() ||
        resolve(marker.repoPath).toLowerCase() !== resolve(".").toLowerCase() ||
        marker.baseUrl !== base ||
        !Number.isInteger(marker.pid) ||
        marker.pid < 1 ||
        !Number.isFinite(Date.parse(marker.processStart))
      )
        throw Error(
          "The launcher marker belongs to another dataset, port, repository or invalid process.",
        );
      const liveStart = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$savedDemoProcess = Get-Process -Id ${marker.pid} -ErrorAction Stop; $savedDemoListener = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq ${marker.pid} }; if (-not $savedDemoListener) { throw 'The launcher process does not own this port.' }; $savedDemoProcess.StartTime.ToUniversalTime().ToString('o')`,
        ],
        { windowsHide: true, encoding: "utf8" },
      ).trim();
      expect(liveStart).toBe(marker.processStart);
      report.launcher = {
        pid: marker.pid,
        processStart: marker.processStart,
        dataPath: marker.dataPath,
        baseUrl: marker.baseUrl,
        liveStart,
        portOwnedByMarkedProcess: true,
      };
      if (priorLauncherFile) {
        const prior = await readJson(priorLauncherFile);
        expect(resolve(prior.dataPath).toLowerCase()).toBe(
          directory.toLowerCase(),
        );
        expect(prior.baseUrl).toBe(base);
        expect(Date.parse(marker.processStart)).toBeGreaterThan(
          Date.parse(prior.processStart),
        );
        report.serviceRestart = {
          verifiedNewProcess: true,
          priorLauncherFile,
          priorPid: prior.pid,
          priorProcessStart: prior.processStart,
          newPid: marker.pid,
          newProcessStart: marker.processStart,
        };
      } else
        report.serviceRestart = {
          verifiedNewProcess: false,
          note: "No prior launcher marker supplied; only the currently running service identity and saved workflow are verified.",
        };
      return marker;
    },
  );
  before = await readJson(join(directory, "db.json"));
  rows = Object.values(before.learning || {});
  meds = Object.values(before.medications || {}).filter(
    (med: any) => !med.archived,
  );
  const jobs = Object.values(before.jobs || {}) as any[];
  const recognition = jobs.find(
    (job) => job.kind === "recognition" && job.status === "succeeded",
  );
  const recognitions = jobs.filter(
    (job) => job.kind === "recognition" && job.status === "succeeded",
  );
  const preparation = await readJson(join(directory, "demo-preparation.json"));
  const expectedCounts = preparation.expectedCounts || {
    medications: 2,
    learning: 2,
  };
  await step("saved-fixture-preflight-and-routing-metadata", async () => {
    const actualCounts: Record<string, number> = {
      medications: meds.length,
      learning: rows.length,
      jobs: jobs.length,
      generated: Object.keys(before.generated || {}).length,
      questions: rows.reduce((count, row) => count + row.result.quiz.length, 0),
      recognitionJobs: jobs.filter((job) => job.kind === "recognition").length,
    };
    for (const [key, expected] of Object.entries(expectedCounts)) {
      expect(Object.hasOwn(actualCounts, key)).toBe(true);
      expect(Number.isInteger(expected) && Number(expected) >= 0).toBe(true);
      expect(actualCounts[key]).toBe(expected);
    }
    report.expectedCounts = expectedCounts;
    report.actualCounts = actualCounts;
    expect(meds).toHaveLength(expectedCounts.medications);
    expect(rows).toHaveLength(expectedCounts.learning);
    expect(meds.length).toBeGreaterThan(0);
    expect(recognition).toBeDefined();
    for (const job of recognitions) {
      expect(job.result.medications.length).toBeGreaterThan(0);
      expect(Object.keys(job.savedMedications || {})).toHaveLength(
        job.result.medications.length,
      );
      for (const saved of Object.values<any>(job.savedMedications || {}))
        expect(meds.some((med) => med.id === saved.id)).toBe(true);
    }
    expect(jobs.some((job) => ["queued", "running"].includes(job.status))).toBe(
      false,
    );
    expect(jobs.every((job) => job.status === "succeeded")).toBe(true);
    for (const row of rows) {
      expect(row.result.status).toBe("supported");
      expect(row.result.quiz.length).toBeGreaterThan(0);
      expect(row.passed).toBe(true);
      for (const q of row.result.quiz) {
        expect(row.answers[q.id]).toBe(q.answer);
        for (const citation of q.citations) {
          const chunk = row.result.chunks.find(
            (c: any) => c.id === citation.chunkId,
          );
          expect(chunk).toBeDefined();
          expect(norm(chunk.text)).toContain(norm(citation.quote));
        }
      }
    }
    const sourceReport = await readJson(join(directory, "report.json"));
    const runtime = await api("/config");
    expect(runtime.mode).toBe("local");
    const snapshotHistoricalRouting = {
      provider: sourceReport.provider,
      textModel: sourceReport.textModel,
      visionModel: sourceReport.visionModel,
      textFallbackModels: sourceReport.fallbackPolicy?.textModels || [],
      visionFallbackModels: sourceReport.fallbackPolicy?.visionModels || [],
    };
    const expectedConfiguredRouting = {
      provider: config.aiProvider,
      textModel: config.textModel,
      visionModel: config.visionModel,
      textFallbackModels:
        config.aiProvider === "nvidia" ? config.nvidiaTextFallbackModels : [],
      visionFallbackModels:
        config.aiProvider === "nvidia" ? config.nvidiaVisionFallbackModels : [],
    };
    const live = {
      provider: runtime.aiProvider,
      textModel: runtime.aiTextModel,
      visionModel: runtime.aiVisionModel,
      textFallbackModels: runtime.aiTextFallbackModels || [],
      visionFallbackModels: runtime.aiVisionFallbackModels || [],
    };
    expect(live).toEqual(expectedConfiguredRouting);
    report.routing = {
      matchedConfigured: true,
      matchedSnapshot: digest(live) === digest(snapshotHistoricalRouting),
      expectedConfiguredRouting,
      snapshotHistoricalRouting,
      live,
      appVersion: runtime.appVersion,
      savedOutputProvenance:
        "Saved explanations and quizzes retain their original generation history. A changed live backup route does not mean these saved outputs were newly generated with that route.",
    };
    report.data = {
      medications: meds.length,
      learning: rows.length,
      recognitionJobs: jobs.filter((job) => job.kind === "recognition").length,
      jobs: jobs.length,
      questions: rows.reduce((n, row) => n + row.result.quiz.length, 0),
      generated: Object.keys(before.generated || {}).length,
    };
    report.beforeHashes = {
      protectedContentAndAnswers: digest(protectedData(before)),
      answers: answerHash(before),
      collections: collectionHashes(before),
    };
    // Retain the marker returned above as an explicit pre-browser ownership checkpoint.
    expect(launcher.pid).toBe(report.launcher.pid);
  });
  token = (await api("/auth/local", "POST", { uid: "local-owner" })).token;
  await step("live-api-matches-marked-dataset", async () => {
    const [liveMeds, liveLearning, liveJobs] = await Promise.all([
      api("/medications"),
      api("/learning"),
      api("/jobs"),
    ]);
    expect(digest(sorted(liveMeds.items))).toBe(digest(sorted(meds)));
    expect(digest(learningFields(liveLearning.items))).toBe(
      digest(learningFields(rows)),
    );
    expect(digest(jobFields(liveJobs.items))).toBe(digest(jobFields(jobs)));
    report.liveDataMatches = true;
  });
  browser = await chromium.launch();
  for (const [label, width, height] of [
    ["desktop", 1280, 900],
    ["mobile", 375, 812],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height } });
    page = await context.newPage();
    page.on("pageerror", (error) => report.browserErrors.push(error.message));
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (/\/api\/v1\/(recognitions|bundles|chat|interactions)$/.test(path) ||
          /\/api\/v1\/(?:admin\/)?jobs\/[^/]+\/retry$/.test(path))
      ) {
        report.unexpectedAiRequests.push({ method: request.method(), path });
        return route.abort();
      }
      await route.continue();
    });
    await page.goto(base);
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await step(label + ":saved-medications-and-recognition", async () => {
      await page!.goto(base + "/#medications");
      await expect(page!.locator(".med-card")).toHaveCount(
        expectedCounts.medications,
      );
      for (const med of meds)
        await expect(
          page!.locator(".med-card").filter({ hasText: med.licenseNo }),
        ).toContainText(med.name);
      for (const job of recognitions) {
        await page!.goto(base + "/#profile");
        await page!.locator(`a[href="#add?recognition=${job.id}"]`).click();
        await expect(
          page!.getByRole("status").filter({
            hasText: `這份辨識的 ${job.result.medications.length} 筆資料已儲存`,
          }),
        ).toBeVisible();
        await expect(
          page!.getByRole("button", { name: "編輯這筆資料", exact: true }),
        ).toHaveCount(0);
      }
    });
    for (const row of rows) {
      const med = meds.find((candidate) =>
        row.medicationIds.includes(candidate.id),
      );
      await page.goto(base + "/#learning");
      const record = page
        .locator(".learning-record")
        .filter({ hasText: med.name });
      const quiz = record.locator(".quiz");
      const openQuestion = async (index: number) => {
        const review = quiz.getByRole("button", {
          name: "重新複習",
          exact: true,
        });
        if (await review.isVisible()) await review.click();
        // Each reload starts with all saved answers correct, so review starts at q0.
        for (let previous = 0; previous < index; previous++)
          await quiz
            .getByRole("button", { name: "下一題", exact: true })
            .click();
      };
      for (let index = 0; index < row.result.quiz.length; index++) {
        const q = row.result.quiz[index];
        await step(
          `${label}:wrong-source-correct-reload:${med.licenseNo}:${q.id}`,
          async () => {
            await expect(
              quiz.getByText("答對了。已完成測驗，進度已保存。", {
                exact: true,
              }),
            ).toBeVisible();
            await openQuestion(index);
            await expect(quiz.locator("legend")).toContainText(q.q);
            const wrong = (q.answer + 1) % q.options.length;
            await quiz.getByRole("radio").nth(wrong).check();
            await quiz
              .getByRole("button", { name: "檢查答案", exact: true })
              .click();
            await expect(quiz.getByText(/再看一下：/)).toBeVisible();
            await expect(
              quiz.getByText(q.explain, { exact: false }),
            ).toBeVisible();
            await expect(quiz.locator(".quiz-feedback blockquote")).toHaveCount(
              q.citations.length,
            );
            for (let c = 0; c < q.citations.length; c++)
              await expect(
                quiz.locator(".quiz-feedback blockquote").nth(c),
              ).toContainText(q.citations[c].quote);
            await page!.reload();
            await expect(quiz.getByRole("radio").nth(wrong)).toBeChecked();
            await expect(quiz.locator("legend")).toContainText(q.q);
            await screenshot(
              `${label}-${med.licenseNo.replace(/[^\w\u4e00-\u9fff]/g, "")}-${q.id}-wrong`,
            );
            await quiz.getByRole("radio").nth(q.answer).focus();
            await page!.keyboard.press("Space");
            await quiz
              .getByRole("button", { name: "檢查答案", exact: true })
              .click();
            await expect(quiz.getByText(/^答對了。/)).toBeVisible();
            await page!.reload();
            await expect(
              quiz.getByText("答對了。已完成測驗，進度已保存。", {
                exact: true,
              }),
            ).toBeVisible();
            const live = (await api("/learning")).items.find(
              (item: any) => item.id === row.id,
            );
            expect(live.answers[q.id]).toBe(q.answer);
            expect(live.progress.passed).toBe(true);
          },
        );
      }
    }
    await step(label + ":layout-and-final-saved-state", async () => {
      expect(
        await page!.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (label === "mobile")
        await expect
          .poll(async () =>
            page!
              .locator(".sidebar")
              .evaluate((el) => el.getBoundingClientRect().right),
          )
          .toBeLessThanOrEqual(0);
      await page!.evaluate(() => window.scrollTo(0, 0));
      await screenshot(label + "-learning");
    });
    await context.close();
    page = undefined;
  }
  await step("zero-ai-and-identical-final-content-answers", async () => {
    expect(report.browserErrors).toEqual([]);
    expect(report.unexpectedAiRequests).toEqual([]);
    const after = await readJson(join(directory, "db.json"));
    report.afterHashes = {
      protectedContentAndAnswers: digest(protectedData(after)),
      answers: answerHash(after),
      collections: collectionHashes(after),
    };
    expect(report.afterHashes).toEqual(report.beforeHashes);
    report.savedContentAndFinalAnswersUnchanged = true;
    report.aiEvidence = {
      newJobs:
        Object.keys(after.jobs || {}).length -
        Object.keys(before.jobs || {}).length,
      jobsAndRequestMetricsUnchanged:
        digest(after.jobs || {}) === digest(before.jobs || {}),
      noQueuedOrRunningJobs: !Object.values(after.jobs || {}).some((job: any) =>
        ["queued", "running"].includes(job.status),
      ),
      browserGenerationAndRetryPostsBlocked: true,
    };
    expect(report.aiEvidence.newJobs).toBe(0);
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  await screenshot("failure").catch(() => {});
  // Restore complete pre-test answers after a UI failure, while retaining the
  // failed report and screenshots. Never replace or edit generated content.
  report.answerRestorationErrors = [];
  if (token && rows.length)
    for (const row of rows) {
      try {
        await api("/learning/" + row.id + "/answers", "POST", {
          answers: row.answers,
        });
      } catch (restoreError) {
        report.answerRestorationErrors.push(
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError),
        );
      }
    }
  if (before) {
    const final = await readJson(join(directory, "db.json"));
    report.finalAfterFailure = {
      contentAndAnswersMatchInitial:
        digest(protectedData(final)) === digest(protectedData(before)),
      answerHash: answerHash(final),
    };
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await save();
}
console.log(
  JSON.stringify(
    {
      reportFile,
      status: report.status,
      scope: report.scope,
      stepsPassed: report.steps.filter((entry: any) => entry.passed).length,
      stepsTotal: report.steps.length,
      realAiCalls: report.realAiCalls,
      data: report.data,
      serviceRestart: report.serviceRestart,
      error: report.error,
    },
    null,
    2,
  ),
);
