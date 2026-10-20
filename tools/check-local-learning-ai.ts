/** Opt-in: five real NVIDIA jobs, isolated health records, no substitute AI responses. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser } from "@playwright/test";
import { config } from "../server/config.js";
import { GROUNDING_VERSION } from "../server/ai.js";
import { hash } from "../server/domain.js";
import type { Drug, GroundedResult, Job, Leaflet } from "../shared/schema.js";

const report: any = {
  createdAt: new Date().toISOString(),
  check: "personal-learning-real-nvidia",
  status: "blocked",
  syntheticPatient: true,
  mockedAI: false,
  maxPaidJobs: 5,
  textModel: config.textModel,
  visionModel: config.visionModel,
  promptVersion: GROUNDING_VERSION,
  steps: [],
};
const base = "http://127.0.0.1:5196";
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let directory: string | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  if (config.mode !== "local")
    throw Error("Use APP_MODE=local for this check.");
  if (!config.nvidiaKey) {
    report.reason = "missing_api_key";
    report.message =
      "NVIDIA_API_KEY is not configured; no real model was called.";
  } else {
    const endpoint = new URL(config.nvidiaBase);
    if (endpoint.origin !== "https://integrate.api.nvidia.com")
      throw Error(
        "This real-AI check requires the official NVIDIA HTTPS endpoint.",
      );
    report.endpoint = endpoint.origin;
    const review = JSON.parse(
      await readFile("data/leaflets/local-reviewed.json", "utf8"),
    );
    let source: any;
    try {
      source = JSON.parse(
        await readFile(config.localPath + "/db.json", "utf8"),
      );
    } catch {
      throw Error("Run npm run prepare:local:demo before this check.");
    }
    const catalog: Drug[] = JSON.parse(
      await readFile(
        config.localPath + "/blobs/" + source.settings.catalog.path,
        "utf8",
      ),
    );
    const drugs = review.items.map((item: any) =>
      catalog.find((d) => d.licenseNo === item.licenseNo),
    );
    if (drugs.some((d: Drug | undefined) => !d))
      throw Error("Both reviewed medicines must exist in the local index.");
    const leaflets: Leaflet[] = review.items.map((item: any) =>
      Object.values<Leaflet>(source.leaflets || {}).find(
        (l) =>
          l.licenseNo === item.licenseNo &&
          l.sha256 === item.sha256 &&
          l.version === item.version &&
          l.status === "published",
      ),
    );
    if (leaflets.some((l) => !l))
      throw Error(
        "Run npm run prepare:local:demo; do not publish unreviewed drafts.",
      );
    for (const leaflet of leaflets) {
      const bytes = await readFile(
        config.localPath + "/blobs/" + leaflet.storagePath,
      );
      if (hash(bytes) !== leaflet.sha256)
        throw Error("A reviewed PDF has changed.");
    }
    report.sources = leaflets.map((l) => ({
      licenseNo: l.licenseNo,
      version: l.version,
      sha256: l.sha256,
      sourceUrl: l.sourceUrl,
    }));
    directory = ".local/learning-ai-" + Date.now();
    report.directory = directory;
    report.sourceReview = review.scope;
    await mkdir(directory + "/blobs/catalog", { recursive: true });
    await writeFile(
      directory + "/blobs/catalog/reviewed.json",
      JSON.stringify(drugs),
    );
    await writeFile(
      directory + "/db.json",
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
            version: "reviewed-local-test",
            path: "catalog/reviewed.json",
          },
        },
      }),
    );
    const portCheck = createServer();
    await new Promise<void>((resolve, reject) => {
      portCheck.once("error", reject);
      portCheck.listen(5196, "127.0.0.1", () =>
        portCheck.close((error) => (error ? reject(error) : resolve())),
      );
    });
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("tools/trace-acceptance-ai.mjs")).href,
        "dist/server/index.mjs",
      ],
      {
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          APP_MODE: "local",
          NODE_ENV: "",
          PORT: "5196",
          LOCAL_DATA_PATH: directory,
          NVIDIA_ACCEPTANCE_TRACE_DIR: resolve(directory),
        },
      },
    );
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null)
        throw Error("The isolated local server could not start.");
      try {
        ready = (
          await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })
        ).ok;
      } catch {}
      if (ready) break;
      await sleep(250);
    }
    if (!ready)
      throw Error("Build first with npm run build, then retry this check.");
    const auth = await (
      await fetch(base + "/api/v1/auth/local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: "local-owner" }),
      })
    ).json();
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(base + "/api/v1" + path, {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: "Bearer " + auth.token,
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw Error("Local API " + path + ": " + data.code);
      return data;
    };
    const checkJob = async (
      step: string,
      path: string,
      input: unknown,
      assert: (job: Job) => void,
    ) => {
      const entry: any = { step, passed: false };
      report.steps.push(entry);
      console.log("Running " + step);
      try {
        const queued = await call(path, "POST", input);
        let job: Job | undefined;
        for (let i = 0; i < 200; i++) {
          await sleep(1800);
          job = await call("/jobs/" + queued.jobId);
          if (job!.status === "failed" || job!.status === "succeeded") break;
        }
        if (!job) throw Error("No job returned.");
        const result = job.result as GroundedResult;
        Object.assign(entry, {
          jobId: job.id,
          status: job.status,
          latencyMs: job.latencyMs,
          tokens:
            job.error?.code === "ai_timeout" && !job.tokens ? null : job.tokens,
          resultStatus: result?.status,
          claims: result?.claims?.length,
          quiz: result?.quiz?.length,
          rejectedCount: result?.rejectedCount,
          personalReferences: result?.claims?.flatMap((c) =>
            (c.profileRefs || []).map((ref) => ({
              ...ref,
              text: c.text,
              citations: c.citations,
            })),
          ),
          citations: result?.claims?.flatMap((c) =>
            c.citations.map((citation) => ({
              quote: citation.quote,
              chunkId: citation.chunkId,
              page: result.chunks.find((ch) => ch.id === citation.chunkId)
                ?.page,
            })),
          ),
        });
        if (job.status !== "succeeded")
          throw Error(job.error?.code || "job_wait_timeout");
        assert(job);
        entry.passed = true;
        return job;
      } catch (e) {
        entry.error = e instanceof Error ? e.message : "unknown_failure";
        return null;
      }
    };
    const assertSupported = (job: Job) => {
      const r = job.result as GroundedResult;
      if (
        r.status !== "supported" ||
        !r.claims.length ||
        r.claims.some((c) => !c.citations.length)
      )
        throw Error("An answer supported by the reviewed source was required.");
    };
    browser = await chromium.launch();
    const imagePage = await browser.newPage({
      viewport: { width: 950, height: 650 },
    });
    await imagePage.setContent(
      '<html lang="zh-Hant"><meta charset="utf-8"><style>body{font:30px Arial;background:white;padding:45px}p{margin:30px 0}</style><small>合成藥袋／測試用途／非真實處方</small><h1>酵素膠囊</h1><p>每次：1 粒　頻次：TID</p><p>途徑：口服　天數：7</p><p>沒有真實患者資料</p></html>',
    );
    const photo = await imagePage.screenshot();
    await imagePage.close();
    await checkJob(
      "recognition",
      "/recognitions",
      { image: photo.toString("base64"), mediaType: "image/png" },
      (job) => {
        const r = job.result as any;
        if (
          r.status !== "succeeded" ||
          !r.medications.some(
            (m: any) =>
              m.name.includes("酵素") &&
              m.doseAmount === 1 &&
              m.frequencyRaw === "TID",
          )
        )
          throw Error("The synthetic photo was not transcribed correctly.");
      },
    );
    await call("/me", "PUT", {
      displayName: "虛構成人／專題驗收",
      age: 32,
      conditions: ["氣喘"],
    });
    const medications = [];
    for (const drug of drugs as Drug[]) {
      const enzyme = drug.licenseNo === "內衛成製字第000544號";
      const med = await call("/medications", "POST", {
        name: drug.nameZh,
        licenseNo: drug.licenseNo,
        doseAmount: 1,
        doseUnit: enzyme ? "粒" : "錠",
        frequencyRaw: enzyme ? "TID" : "PRN",
        prn: !enzyme,
        confirmed: true,
        rawText: "虛構測試用法，不是真實處方",
      });
      medications.push(med);
      const bundle = await checkJob(
        "bundle:" + drug.licenseNo,
        "/bundles",
        { medicationIds: [med.id] },
        (job) => {
          assertSupported(job);
          const r = job.result as GroundedResult;
          if (!r.quiz.length || r.quiz.some((q) => !q.citations.length))
            throw Error(
              "The bundle needs questions, each with its own source evidence.",
            );
          if (
            r.safetyCoverage &&
            (r.safetyCoverage.coveredSectionCount !==
              r.safetyCoverage.sourceSectionCount ||
              r.safetyCoverage.quizCoveredSectionCount !==
                r.safetyCoverage.sourceSectionCount)
          )
            throw Error(
              "Every recognized safety section needs full text and a key-point question.",
            );
          if (enzyme && r.claims.some((c) => c.profileRefs?.length))
            throw Error(
              "The enzyme source does not support a personal warning for this fixture.",
            );
          if (
            drug.licenseNo === "衛署藥製字第026087號" &&
            !r.claims.some((c) =>
              c.profileRefs?.some(
                (f) => f.field === "conditions" && f.value === "氣喘",
              ),
            )
          )
            throw Error(
              "The source explicitly mentions this synthetic patient's condition; a verified warning reference was required.",
            );
        },
      );
      if (bundle) {
        const questions = (bundle.result as GroundedResult).quiz;
        for (const q of questions)
          await call("/learning/" + bundle.id + "/answers", "POST", {
            answers: { [q.id]: q.answer },
          });
        const row = (await call("/learning")).items.find(
          (r: any) => r.id === bundle.id,
        );
        report.steps.push({
          step: "saved-progress:" + drug.licenseNo,
          passed: row?.progress?.passed === true,
        });
      }
      await checkJob(
        "chat:" + drug.licenseNo,
        "/chat",
        {
          medicationIds: [med.id],
          question: "請只說明本藥仿單記載的適應症或用途，並引用原文。",
        },
        (job) => {
          assertSupported(job);
          if ((job.result as GroundedResult).quiz.length)
            throw Error("Chat must not generate a quiz.");
        },
      );
    }
    // Missing-source behavior does not call NVIDIA and does not consume an AI response.
    const noSource = await call("/medications", "POST", {
      name: "虛構未匹配藥品",
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
      confirmed: true,
    });
    await checkJob(
      "missing-source:no-model-call",
      "/bundles",
      { medicationIds: [noSource.id] },
      (job) => {
        const r = job.result as GroundedResult;
        if (
          r.status !== "insufficient_data" ||
          r.claims.length ||
          r.quiz.length
        )
          throw Error("Missing source must remain explicit.");
      },
    );
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(base);
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await page.goto(base + "/#learning");
    await page.locator(".learning-index-card").first().waitFor();
    // Reuse the real generated questions; no additional model request or substitute content.
    const learning = (await call("/learning")).items;
    const coughMed = medications.find(
      (m) => m.licenseNo === "衛署藥製字第026087號",
    );
    const coughRow = learning.find(
      (r: any) =>
        r.medicationIds.includes(coughMed?.id) && r.result.quiz.length,
    );
    if (coughRow) {
      const recordUrl =
        base +
        "/#learning?record=" +
        encodeURIComponent(coughRow.id) +
        "&section=quiz";
      await page.goto(recordUrl);
      for (const [viewport, width, height] of [
        ["desktop", 1280, 900],
        ["mobile", 375, 812],
      ] as const) {
        const entry: any = {
          step: "real-content-browser:" + viewport,
          passed: false,
        };
        report.steps.push(entry);
        try {
          await page.setViewportSize({ width, height });
          const record = page.locator(
            `.learning-record[data-learning-id="${coughRow.id}"]`,
          );
          await expect(page.locator(".learning-record")).toHaveCount(1);
          await expect(record).toContainText(coughMed.name);
          const quiz = record.locator(".quiz");
          const q = coughRow.result.quiz[0];
          const wrong = (q.answer + 1) % q.options.length;
          await quiz
            .getByRole("button", { name: "重新複習", exact: true })
            .click();
          await quiz.getByRole("radio").nth(wrong).check();
          await quiz
            .getByRole("button", { name: "檢查答案", exact: true })
            .click();
          await expect(quiz.getByText(/再看一下：/)).toBeVisible();
          await expect(
            quiz.locator(".quiz-feedback blockquote").first(),
          ).toBeVisible();
          await page.reload();
          await expect(quiz.getByRole("radio").nth(wrong)).toBeChecked();
          await page.getByRole("button", { name: "登出", exact: true }).click();
          await page
            .getByRole("button", { name: "本機使用者", exact: true })
            .click();
          await page.goto(recordUrl);
          await expect(quiz.getByRole("radio").nth(wrong)).toBeChecked();
          const source = record
            .getByText("對照仿單原文", { exact: true })
            .first();
          await source.focus();
          await page.keyboard.press("Enter");
          await expect(
            record.locator(".education-card blockquote").first(),
          ).toBeVisible();
          await quiz.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: directory + "/" + viewport + "-wrong-answer.png",
            fullPage: true,
          });
          await quiz.getByRole("radio").nth(q.answer).focus();
          await page.keyboard.press("Space");
          await quiz
            .getByRole("button", { name: "檢查答案", exact: true })
            .focus();
          await page.keyboard.press("Enter");
          await expect(
            quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
          ).toBeVisible();
          await page.reload();
          await expect(
            quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
          ).toBeVisible();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          entry.passed = true;
          entry.checks = [
            "wrong-answer-source",
            "reload",
            "logout-login",
            "keyboard-quote",
            "keyboard-answer",
            "completion-persisted",
            "no-horizontal-overflow",
          ];
        } catch (e) {
          entry.error = e instanceof Error ? e.message : "browser_failure";
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: directory + "/desktop.png", fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: directory + "/mobile.png", fullPage: true });
    report.status = report.steps.every((s: any) => s.passed)
      ? "passed"
      : "failed";
  }
} catch (e) {
  report.status = directory ? "failed" : "blocked";
  report.error = e instanceof Error ? e.message : "unknown_failure";
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  }
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/personal-learning-real-ai.json",
    JSON.stringify(report, null, 2),
  );
  if (directory)
    await writeFile(
      directory + "/report.json",
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}
