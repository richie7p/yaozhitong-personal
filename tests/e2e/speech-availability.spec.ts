import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ serviceWorkers: "block" });

type SpeechMode = "deleted" | "undefined" | "missing-controller" | "missing-constructor" | "supported";

async function speechEnvironment(page: Page, mode: SpeechMode) {
  await page.addInitScript((mode) => {
    const state = { spoken: [] as { text: string; lang: string; rate: number }[], cancels: 0, active: null as any };
    (window as any).syntheticSpeech = state;
    const synthesis = {
      cancel() { state.cancels++; state.active = null; },
      speak(utterance: any) {
        state.spoken.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate });
        state.active = utterance;
      },
    };
    class Utterance {
      lang = "";
      rate = 1;
      onend: (() => void) | null = null;
      constructor(public text: string) {}
    }
    for (const name of ["speechSynthesis", "SpeechSynthesisUtterance"] as const) {
      if (mode === "deleted") {
        let target: any = window;
        while (target) {
          const descriptor = Object.getOwnPropertyDescriptor(target, name);
          if (descriptor) {
            if (!Reflect.deleteProperty(target, name)) throw new Error("Cannot remove synthetic speech capability");
            break;
          }
          target = Object.getPrototypeOf(target);
        }
      } else {
        const available = name === "speechSynthesis"
          ? mode === "supported" || mode === "missing-constructor"
          : mode === "supported" || mode === "missing-controller";
        Object.defineProperty(window, name, {
          configurable: true,
          value: available ? name === "speechSynthesis" ? synthesis : Utterance : undefined,
        });
      }
    }
  }, mode);
}

async function savedReading(page: Page, origin: string) {
  // Reuse the existing public/deidentified saved source fixture, never generate content.
  const fixture = JSON.parse(readFileSync("tests/fixtures/quiz-presentation-saved-source.json", "utf8"));
  const recordId = "synthetic-optional-speech-record", questionId = "synthetic-optional-speech-question";
  const citation = { chunkId: "synthetic-optional-speech-source", quote: fixture.options[1] };
  const result = {
    status: "supported",
    claims: [{ text: citation.quote, kind: "source_exact_safety", category: "warning", citations: [citation] }],
    chunks: [{ id: citation.chunkId, licenseNo: "SYNTHETIC-SPEECH", version: "public-text-fixture", page: 2, start: 0, text: citation.quote }],
    quiz: [{ ...fixture, id: questionId, answer: 1, explain: citation.quote, citations: [citation] }],
    followups: [], rejectedCount: 0, sourceVersions: {}, verification: "model_assisted",
  };
  const medication = {
    id: "synthetic-optional-speech-medication", name: "合成閱讀測試藥品",
    licenseNo: "SYNTHETIC-SPEECH", revision: 1, confirmed: true,
    identityReview: { status: "confirmed", missingFields: [] },
    doseAmount: 1, doseUnit: "錠", frequencyRaw: "QD",
  };
  const record = {
    id: recordId, ownerId: "synthetic-optional-speech-owner", medicationIds: [medication.id],
    medicationRevisions: [{ id: medication.id, revision: 1 }], profileVersion: 0,
    result, answers: {}, createdAt: "2026-10-24T00:00:00Z",
  };
  const unexpected: string[] = [], writes: string[] = [];
  await page.addInitScript(() => sessionStorage.setItem("yzt-local-token", "synthetic-optional-speech-only"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.method() + " " + url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/v1/")) { await route.continue(); return; }
    if (request.method() !== "GET") { writes.push(request.method() + " " + url.pathname); await route.abort(); return; }
    const reads: Record<string, unknown> = {
      "/api/v1/config": { mode: "local", ai: false },
      "/api/v1/me": { account: { id: record.ownerId, displayName: "合成閱讀測試", eligible: true, admin: false }, profile: {} },
      "/api/v1/medications": { items: [medication] },
      "/api/v1/learning": { items: [record] },
      "/api/v1/jobs": { items: [] },
      "/api/v1/today": { items: [] },
    };
    if (url.pathname in reads) { await route.fulfill({ json: reads[url.pathname] }); return; }
    unexpected.push(request.method() + " " + url.pathname); await route.abort();
  });
  return { recordId, text: citation.quote, unexpected, writes };
}

test("optional speech APIs never erase saved reading, citations or route navigation", async ({ context }, info) => {
  const origin = new URL(info.project.use.baseURL as string).origin;
  const browser = context.browser()!;
  await info.attach("speech-runtime", {
    body: JSON.stringify({ engine: browser.browserType().name(), version: browser.version() }),
    contentType: "application/json",
  });
  for (const mode of ["deleted", "undefined", "missing-controller", "missing-constructor", "supported"] as const) {
    // Each fresh page inherits the runner's device/proxy/context options.
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await speechEnvironment(page, mode);
      const state = await savedReading(page, origin);
      await page.goto("/#demo?record=" + state.recordId + "&step=reading");
      const capabilities = await page.evaluate(() => ({
        synthesis: typeof window.speechSynthesis,
        utterance: typeof window.SpeechSynthesisUtterance,
      }));
      expect(capabilities).toEqual({
        synthesis: mode === "supported" || mode === "missing-constructor" ? "object" : "undefined",
        utterance: mode === "supported" || mode === "missing-controller" ? "function" : "undefined",
      });
      const evidence = page.locator(".evidence");
      await expect(evidence.locator(".claim p").first()).toHaveText(state.text);
      await evidence.getByText("對照仿單原文", { exact: true }).first().click();
      await expect(evidence.locator("blockquote").first()).toBeVisible();
      await expect(evidence.locator("blockquote").first()).toContainText(state.text);
      if (mode === "supported") {
        await evidence.getByRole("button", { name: "朗讀說明", exact: true }).click();
        await expect(evidence.getByRole("button", { name: "停止朗讀", exact: true })).toBeVisible();
        expect(await page.evaluate(() => (window as any).syntheticSpeech.spoken)).toEqual([{ text: state.text, lang: "zh-TW", rate: 0.85 }]);
        await evidence.getByRole("button", { name: "停止朗讀", exact: true }).click();
        await expect(evidence.getByRole("button", { name: "朗讀說明", exact: true })).toBeVisible();
        await evidence.getByRole("button", { name: "朗讀說明", exact: true }).click();
        await page.evaluate(() => (window as any).syntheticSpeech.active.onend());
        await expect(evidence.getByRole("button", { name: "朗讀說明", exact: true })).toBeVisible();
        await evidence.getByRole("button", { name: "朗讀說明", exact: true }).click();
      }
      const cancelsBefore = await page.evaluate(() => (window as any).syntheticSpeech.cancels);
      // This unmounts the reading Speak component without navigating the document.
      await page.getByRole("link", { name: "下一步：理解測驗", exact: true }).click();
      await expect(page.getByRole("heading", { name: "理解測驗", level: 2, exact: true })).toBeVisible();
      await expect(page.locator(".quiz fieldset")).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      if (mode === "supported") {
        expect(await page.evaluate(() => (window as any).syntheticSpeech.cancels)).toBeGreaterThan(cancelsBefore);
        expect(await page.evaluate(() => (window as any).syntheticSpeech.active)).toBeNull();
      }
      await page.getByRole("link", { name: "上一步：仿單說明", exact: true }).click();
      await expect(evidence.locator(".claim p").first()).toHaveText(state.text);
      if (mode !== "supported") {
        await expect(evidence.getByRole("button", { name: /朗讀/ })).toHaveCount(0);
        await expect(evidence.getByText("目前無法朗讀，可繼續閱讀文字。", { exact: true })).toBeVisible();
      }
      await page.getByRole("link", { name: "返回日常使用", exact: true }).click();
      await expect(page.getByRole("heading", { name: "今天的用藥日常", exact: true })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      expect(errors).toEqual([]);
      expect(state.writes).toEqual([]);
      expect(state.unexpected).toEqual([]);
      await page.screenshot({ path: info.outputPath("optional-speech-" + mode + ".png") });
    } finally {
      await page.close();
    }
  }
});
