/** Exercise saved seminar results after a verified Windows reboot. No new AI calls. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";

const directory = resolve(
  process.argv[2] || ".local/seminar-demo-expanded-v11-20261020",
);
const port = Number(process.argv[3] || 8085);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid demonstration port.");
const base = "http://127.0.0.1:" + port;
const reboot = JSON.parse(
  await readFile(".local/reports/seminar-windows-reboot.json", "utf8"),
);
if (reboot.status !== "passed" || !reboot.osRebooted)
  throw Error("First complete the actual Windows reboot verification.");
if (
  reboot.directory
    ? resolve(reboot.directory).toLowerCase() !== directory.toLowerCase() ||
      reboot.port !== port
    : directory.toLowerCase() !==
        resolve(".local/seminar-demo-v9-20261019").toLowerCase() ||
      port !== 8085
)
  throw Error(
    "The recorded Windows reboot belongs to another demonstration dataset.",
  );
const before = JSON.parse(await readFile(directory + "/db.json", "utf8"));
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
const digest = (db: any) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical(
          Object.fromEntries(
            ["medications", "learning", "generated", "jobs", "profiles"].map(
              (key) => [key, db[key] || {}],
            ),
          ),
        ),
      ),
    )
    .digest("hex");
const rows = Object.values(before.learning) as any[];
const meds = Object.values(before.medications) as any[];
const preparation = JSON.parse(
  await readFile(directory + "/demo-preparation.json", "utf8"),
);
const expectedCounts = preparation.expectedCounts || {
  medications: 2,
  learning: 2,
};
expect(meds).toHaveLength(expectedCounts.medications);
expect(rows).toHaveLength(expectedCounts.learning);
const jobs = Object.values(before.jobs || {}) as any[];
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
expect(jobs.every((job) => job.status === "succeeded")).toBe(true);
const recognition = (Object.values(before.jobs) as any[]).find(
  (j) => j.kind === "recognition",
);
const recognitions = (Object.values(before.jobs) as any[]).filter(
  (job) => job.kind === "recognition" && job.status === "succeeded",
);
expect(recognitions.length).toBeGreaterThan(0);
const report: any = {
  startedAt: new Date().toISOString(),
  directory,
  port,
  osRebootVerified: true,
  realAiCalls: 0,
  steps: [],
  browserErrors: [],
  unexpectedAiRequests: [],
  expectedCounts,
  actualCounts,
};
const browser = await chromium.launch();
let token = "";
const loginResponse = await fetch(base + "/api/v1/auth/local", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ uid: "local-owner" }),
});
if (!loginResponse.ok) throw Error("Local sign-in failed");
token = (await loginResponse.json()).token;
try {
  for (const [label, width, height] of [
    ["desktop", 1280, 900],
    ["mobile", 375, 812],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.browserErrors.push(e.message));
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (/\/(recognitions|bundles|chat|interactions)$/.test(path) ||
          /\/api\/v1\/(?:admin\/)?jobs\/[^/]+\/retry$/.test(path))
      ) {
        report.unexpectedAiRequests.push(request.url());
        return route.abort();
      }
      await route.continue();
    });
    await page.goto(base);
    await page.getByRole("button", { name: "本機使用者", exact: true }).click();
    await page.goto(base + "/#medications");
    await expect(page.locator(".med-card")).toHaveCount(
      expectedCounts.medications,
    );
    for (const job of recognitions) {
      expect(Object.keys(job.savedMedications || {})).toHaveLength(
        job.result.medications.length,
      );
      await page.goto(base + "/#profile");
      await page.locator(`a[href="#add?recognition=${job.id}"]`).click();
      await expect(
        page.getByRole("status").filter({
          hasText: `這份辨識的 ${job.result.medications.length} 筆資料已儲存`,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "編輯這筆資料", exact: true }),
      ).toHaveCount(0);
    }
    report.steps.push({
      step: label + ":saved-recognition-resume",
      passed: true,
      savedMedications: recognitions.reduce(
        (n, job) => n + job.result.medications.length,
        0,
      ),
    });
    for (const row of rows) {
      const med = meds.find((m) => row.medicationIds.includes(m.id));
      await page.goto(base + "/#learning");
      const record = page
        .locator(".learning-record")
        .filter({ hasText: med.name });
      const quiz = record.locator(".quiz");
      await expect(
        quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
      ).toBeVisible();
      await quiz.getByRole("button", { name: "重新複習", exact: true }).click();
      for (let index = 0; index < row.result.quiz.length; index++) {
        const q = row.result.quiz[index];
        await expect(quiz.locator("legend")).toContainText(q.q);
        await quiz
          .getByRole("radio")
          .nth((q.answer + 1) % q.options.length)
          .check();
        await quiz
          .getByRole("button", { name: "檢查答案", exact: true })
          .click();
        await expect(quiz.getByText(/再看一下：/)).toBeVisible();
        await expect(quiz.getByText(q.explain, { exact: false })).toBeVisible();
        for (const citation of q.citations)
          await expect(
            quiz
              .locator(".quiz-feedback blockquote")
              .filter({ hasText: citation.quote }),
          ).toBeVisible();
        if (index === 0) {
          await page.reload();
          await expect(
            quiz.getByRole("radio").nth((q.answer + 1) % q.options.length),
          ).toBeChecked();
        }
        await quiz.scrollIntoViewIfNeeded();
        if (index === 0)
          await page.screenshot({
            path:
              directory +
              `/postboot-${label}-${med.licenseNo.replace(/[^\w\u4e00-\u9fff]/g, "")}-wrong.png`,
            animations: "disabled",
          });
        await quiz.getByRole("radio").nth(q.answer).focus();
        await page.keyboard.press("Space");
        await quiz
          .getByRole("button", { name: "檢查答案", exact: true })
          .click();
        await expect(quiz.getByText(/^答對了。/)).toBeVisible();
        if (index < row.result.quiz.length - 1) {
          const review = quiz.getByRole("button", {
            name: "重新複習",
            exact: true,
          });
          if (await review.count()) await review.click();
          await quiz
            .getByRole("button", { name: "下一題", exact: true })
            .click();
        }
      }
      const finish = quiz.getByRole("button", {
        name: "完成複習",
        exact: true,
      });
      if (await finish.count()) await finish.click();
      await expect(
        quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        quiz.getByText("答對了。已完成測驗，進度已保存。", { exact: true }),
      ).toBeVisible();
      report.steps.push({
        step: label + ":source-quiz-persistence:" + med.licenseNo,
        passed: true,
        questions: row.result.quiz.length,
        wrongThenSourceThenCorrect: true,
        reloadPreserved: true,
      });
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (label === "mobile")
      await expect
        .poll(async () =>
          page
            .locator(".sidebar")
            .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: directory + `/postboot-${label}-learning.png`,
      animations: "disabled",
    });
    await context.close();
  }
  expect(report.browserErrors).toEqual([]);
  expect(report.unexpectedAiRequests).toEqual([]);
  const after = JSON.parse(await readFile(directory + "/db.json", "utf8"));
  report.aiEvidence = {
    newJobs:
      Object.keys(after.jobs || {}).length -
      Object.keys(before.jobs || {}).length,
    jobsAndMetricsUnchanged:
      JSON.stringify(canonical(after.jobs || {})) ===
      JSON.stringify(canonical(before.jobs || {})),
    noQueuedOrRunningJobs: !Object.values<any>(after.jobs || {}).some((job) =>
      ["queued", "running"].includes(job.status),
    ),
    generationAndRetryPostsBlocked: true,
  };
  expect(report.aiEvidence.newJobs).toBe(0);
  expect(report.aiEvidence.jobsAndMetricsUnchanged).toBe(true);
  expect(report.aiEvidence.noQueuedOrRunningJobs).toBe(true);
  expect(digest(after)).toBe(digest(before));
  report.savedContentAndFinalAnswersUnchanged = true;
  report.jobs = Object.keys(after.jobs).length;
  report.quiz = rows.reduce((n, row) => n + row.result.quiz.length, 0);
  report.status = "passed";
} catch (e: any) {
  report.status = "failed";
  report.error = e.message;
  // Restore the pre-test answers without hiding a failed check in this report.
  for (const row of rows)
    await fetch(base + "/api/v1/learning/" + row.id + "/answers", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ answers: row.answers }),
    });
  process.exitCode = 1;
} finally {
  await browser.close();
}
report.finishedAt = new Date().toISOString();
await writeFile(
  ".local/reports/seminar-postboot-ui.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
