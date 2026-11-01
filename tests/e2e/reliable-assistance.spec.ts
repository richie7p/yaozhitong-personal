import { test, expect } from "@playwright/test";
import { assisted } from "../../server/assistance";
import type { Medication } from "../../shared/schema";
test.use({ serviceWorkers: "block" });
for (const state of ["found", "not_found", "unavailable"] as const)
  test(`ordinary user can explain and ask without an indexed leaflet: ${state}`, async ({
    page,
  }) => {
    const med = {
      id: "synthetic-med",
      name: "合成未收錄仿單錠",
      licenseNo: "SYNTHETIC-MISSING",
      confirmed: true,
      revision: 1,
      doseAmount: 1,
      doseUnit: "錠",
      frequencyRaw: "QD",
      identityReview: { status: "confirmed", missingFields: [] },
    };
    const fixture = {
      status: "supported",
      claims: [],
      chunks: [],
      quiz: [],
      followups: [],
      rejectedCount: 0,
      sourceVersions: {},
      verification: "model_assisted",
      assistance: {
        version: "reliable-reference-v3",
        checkedAt: new Date().toISOString(),
        searchState: state,
        sources:
          state === "found"
            ? [
                {
                  id: "web-1",
                  title: "合成官方醫療來源",
                  url: "https://www.ntuh.gov.tw/synthetic-reference",
                  kind: "hospital",
                },
              ]
            : [],
        claims: [
          {
            text:
              state === "found"
                ? "這是有來源的合成一般資訊。"
                : "你記錄的 QD 是每日一次的縮寫。",
            basis: state === "found" ? "reference" : "user_label",
            sourceIds: state === "found" ? ["web-1"] : [],
          },
        ],
        uncertainties: [
          "本站尚未收錄這款產品的官方仿單。",
          state === "found"
            ? "不同廠牌或規格仍待核對。"
            : state === "not_found"
              ? "這次未找到能引用的可靠資料。"
              : "這次可靠來源搜尋暫時無法完成。",
        ],
      },
    };
    const result =
      state === "found"
        ? fixture
        : await assisted(
            {
              searchReferences: async () => ({
                state,
                sources: [],
                passages: [],
              }),
              json: async () => {
                throw Error(
                  "No-evidence UI must not depend on model-authored medical text",
                );
              },
            },
            "用途、副作用和 QD 是什麼？",
            [med as unknown as Medication],
            [
              {
                licenseNo: med.licenseNo,
                nameZh: med.name,
                nameEn: "Synthetic missing",
                strength: "",
                form: "錠",
                ingredients: ["SYNTHETIC"],
                revoked: false,
              },
            ],
            [null],
          );
    const record = {
      id: "synthetic-bundle",
      medicationIds: [med.id],
      result,
      answers: {},
      createdAt: new Date().toISOString(),
    };
    let explained = false,
      asked = false;
    const unexpected: string[] = [];
    await page.addInitScript(() =>
      sessionStorage.setItem("yzt-local-token", "synthetic-reference-user"),
    );
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.slice(
        "/api/v1".length,
      );
      if (route.request().method() === "POST" && path === "/bundles") {
        explained = true;
        return route.fulfill({
          status: 202,
          json: { jobId: record.id, status: "queued" },
        });
      }
      if (route.request().method() === "POST" && path === "/chat") {
        asked = true;
        return route.fulfill({
          status: 202,
          json: { jobId: "synthetic-chat", status: "queued" },
        });
      }
      const reads: Record<string, unknown> = {
        "/config": {
          mode: "local",
          ai: true,
          dailyUserLimit: 20,
          dailyGlobalLimit: 1000,
        },
        "/me": {
          account: {
            id: "synthetic-reference-user",
            eligible: true,
            admin: false,
          },
          profile: {},
        },
        "/medications": { items: [med] },
        "/learning": { items: explained ? [record] : [] },
        "/chat": {
          items: asked
            ? [{ ...record, id: "synthetic-chat", question: "QD 是什麼意思？" }]
            : [],
        },
        ["/medications/" + med.id + "/source"]: {
          medicationId: med.id,
          medicationRevision: 1,
          state: "missing",
          sources: [],
        },
        "/jobs/synthetic-bundle": {
          id: record.id,
          status: "succeeded",
          result,
        },
        "/jobs/synthetic-chat": {
          id: "synthetic-chat",
          status: "succeeded",
          result,
        },
      };
      if (path in reads) return route.fulfill({ json: reads[path] });
      unexpected.push(path);
      await route.abort();
    });
    await page.goto("/#medications");
    await page
      .getByRole("button", { name: "官方仿單原文", exact: true })
      .click();
    await expect(
      page.getByText("本站尚未收錄這款藥的官方仿單，仍可使用 AI 解說與問答。", {
        exact: false,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "使用 AI 解說", exact: true })
      .click();
    const answer = page.getByRole("region", {
      name: "AI 藥品解說與問答",
      exact: true,
    });
    await expect(answer).toBeVisible();
    await expect(answer).toContainText("尚待確認的部分");
    if (state === "found")
      await expect(
        answer.getByRole("link", { name: /合成官方醫療來源/ }),
      ).toHaveAttribute("href", "https://www.ntuh.gov.tw/synthetic-reference");
    else {
      await expect(answer).toContainText("依你記錄的藥袋文字");
      await expect(answer.getByRole("link")).toHaveCount(0);
      await expect(answer).toContainText(
        state === "not_found" ? "未找到能引用" : "搜尋暫時無法完成",
      );
    }
    await expect(answer).not.toContainText("已附仿單依據");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.goto("/#chat");
    await page.getByRole("checkbox", { name: med.name, exact: true }).check();
    await page
      .getByRole("textbox", { name: "用藥問題" })
      .fill("QD 是什麼意思？");
    await page.getByRole("button", { name: "送出", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "AI 藥品解說與問答", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("region", { name: "AI 藥品解說與問答", exact: true }),
    ).toBeVisible();
    expect(unexpected).toEqual([]);
  });
