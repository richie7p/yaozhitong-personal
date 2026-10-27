import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

// Synthetic UI fixtures only. Every API request is fulfilled in the browser;
// these tests never create a schedule in a backend or enable notifications.
const medications = [
  {
    id: "synthetic-reminder-first",
    name: "合成提醒測試藥品",
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
    confirmed: true,
    prn: false,
    route: "口服",
    createdAt: "2026-10-20T02:00:00.000Z",
  },
  {
    id: "synthetic-reminder-second",
    name: "合成提醒測試藥品",
    doseAmount: 2,
    doseUnit: "錠",
    frequencyRaw: "BID",
    confirmed: true,
    prn: false,
    route: "口服",
    createdAt: "2026-10-21T02:00:00.000Z",
  },
];
const selectedMedication = medications[1];

interface ScheduleInput {
  medicationId: string;
  times: string[];
  startDate: string;
  endDate: string | null;
}

async function openReminder(
  page: Page,
  options: {
    failFirst?: boolean;
    saveGate?: Promise<void>;
    medicationId?: string;
    allowMedicationEdits?: boolean;
  } = {},
) {
  const attempts: ScheduleInput[] = [];
  const persisted: ScheduleInput[] = [];
  const medicationEdits: {
    medicationId: string;
    input: Record<string, unknown>;
  }[] = [];
  const currentMedications = medications.map((medication) => ({
    ...medication,
  }));
  const unexpected: string[] = [];
  await page.addInitScript(() => {
    sessionStorage.setItem("yzt-local-token", "synthetic-reminder-ui-only");
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:5190") {
      unexpected.push(request.method() + " " + url.origin + url.pathname);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      await route.continue();
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/v1/config": { mode: "local", ai: false },
      "/api/v1/me": {
        account: {
          id: "synthetic-reminder-owner",
          displayName: "合成提醒測試使用者",
          eligible: true,
          admin: false,
        },
        profile: { displayName: "合成提醒測試使用者" },
      },
      "/api/v1/medications": { items: currentMedications, duplicates: [] },
    };
    if (request.method() === "GET" && url.pathname in responses) {
      await route.fulfill({ json: responses[url.pathname] });
      return;
    }
    if (options.allowMedicationEdits && request.method() === "PUT") {
      const index = currentMedications.findIndex(
        (medication) => url.pathname === `/api/v1/medications/${medication.id}`,
      );
      if (index >= 0) {
        const input = request.postDataJSON() as Record<string, unknown>;
        const medicationId = currentMedications[index].id;
        medicationEdits.push({ medicationId, input });
        currentMedications[index] = {
          ...currentMedications[index],
          ...input,
          id: medicationId,
        };
        await route.fulfill({ json: currentMedications[index] });
        return;
      }
    }
    if (request.method() === "POST" && url.pathname === "/api/v1/schedules") {
      const input = request.postDataJSON() as ScheduleInput;
      attempts.push(input);
      if (options.failFirst && attempts.length === 1) {
        await route.fulfill({
          status: 503,
          json: {
            code: "synthetic_unavailable",
            message: "合成測試：服務暫時忙碌，請重試。",
          },
        });
        return;
      }
      if (options.saveGate) await options.saveGate;
      persisted.push(input);
      await route.fulfill({
        json: {
          ...input,
          id: "synthetic-reminder-schedule",
          active: true,
          timezone: "Asia/Taipei",
        },
      });
      return;
    }
    unexpected.push(request.method() + " " + url.pathname);
    await route.abort();
  });
  await page.goto("/#medications");
  await expect(page.locator(".med-card")).toHaveCount(2);
  const form = page.locator(".schedule-form form");
  const openMedication = async (medicationId: string) => {
    await page
      .locator(`.med-card[data-medication-id="${medicationId}"]`)
      .getByRole("button", { name: "排定提醒", exact: true })
      .click();
    await expect(form).toBeVisible();
    await expect(
      page.locator(".schedule-form .medication-identity"),
    ).toHaveAttribute("title", `完整編號：${medicationId}`);
  };
  await openMedication(options.medicationId || selectedMedication.id);
  return {
    form,
    attempts,
    persisted,
    medicationEdits,
    unexpected,
    openMedication,
  };
}

test("manual reminders explain the time format, reject invalid input before sending, and save only the chosen medication", async ({
  page,
}) => {
  const { form, attempts, persisted, unexpected } = await openReminder(page);
  const times = form.getByLabel("每天提醒時間");
  const submit = form.getByRole("button", {
    name: "確認提醒時間",
    exact: true,
  });
  await expect(page.locator(".schedule-form")).toContainText("BID");
  await expect(times).toHaveValue("");
  await expect(times).toHaveAttribute("aria-describedby", /-times-help/);
  await expect(times).toHaveAccessibleDescription(
    /早上 8 點填 08:00；晚上 8 點填 20:00/,
  );
  const helperId = await times.getAttribute("aria-describedby");
  const helper = page.locator(`[id="${helperId}"]`);
  await expect(helper).toBeVisible();
  await expect(helper).toContainText("08:00, 20:00");

  for (const [input, message] of [
    ["", "請至少填寫一個提醒時間"],
    ["8pm", "提醒時間請用 24 小時制"],
    ["24:00", "00:00～23:59"],
    ["8:00，08:00", "提醒時間 08:00 重複了"],
  ]) {
    await times.fill(input);
    await submit.click();
    await expect(form.getByRole("alert")).toContainText(message);
    await expect(times).toHaveAttribute("aria-invalid", "true");
    await expect(times).toBeFocused();
    await expect(helper).toBeVisible();
    expect(attempts).toEqual([]);
  }

  await times.fill("8:05，12:30、20:00");
  await form.getByLabel("開始日期", { exact: true }).fill("2030-01-02");
  const end = form.getByLabel("結束日期（可留白）", { exact: true });
  await end.fill("2030-01-01");
  await submit.click();
  await expect(form.getByRole("alert")).toContainText(
    "結束日期不能早於開始日期",
  );
  await expect(end).toBeFocused();
  expect(attempts).toEqual([]);
  await end.fill("2030-01-09");
  await expect(helper).toBeVisible();
  await submit.click();
  await expect(form).toHaveCount(0);
  expect(attempts).toEqual([
    {
      medicationId: selectedMedication.id,
      times: ["08:05", "12:30", "20:00"],
      startDate: "2030-01-02",
      endDate: "2030-01-09",
    },
  ]);
  expect(persisted).toEqual(attempts);
  expect(unexpected).toEqual([]);
});

test("a completed older save cannot close a new reminder session for the same medication", async ({
  page,
}) => {
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const { form, attempts, persisted, unexpected, openMedication } =
    await openReminder(page, { saveGate, medicationId: medications[0].id });
  const times = form.getByLabel("每天提醒時間");
  await times.fill("7:30");
  await form.getByLabel("開始日期", { exact: true }).fill("2030-03-01");
  const oldResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/schedules",
  );
  await form.getByRole("button", { name: "確認提醒時間", exact: true }).click();
  try {
    await expect.poll(() => attempts.length).toBe(1);
    await expect(times).toBeDisabled();

    await openMedication(medications[1].id);
    await expect(times).toHaveValue("");
    await times.fill("12:45");
    await openMedication(medications[0].id);
    await expect(times).toHaveValue("");
    await times.fill("17:45");
    await form.getByLabel("開始日期", { exact: true }).fill("2030-03-10");
    await expect(form).toHaveAttribute("aria-busy", "false");
    expect(persisted).toEqual([]);
  } finally {
    releaseSave();
  }
  await (await oldResponse).finished();
  // Give the released response a rendering frame to run its completion callback.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await expect(form).toBeVisible();
  await expect(times).toHaveValue("17:45");
  await expect(form.getByLabel("開始日期", { exact: true })).toHaveValue(
    "2030-03-10",
  );
  await expect(
    form.getByRole("button", { name: "確認提醒時間", exact: true }),
  ).toBeEnabled();
  expect(attempts).toEqual([
    {
      medicationId: medications[0].id,
      times: ["07:30"],
      startDate: "2030-03-01",
      endDate: null,
    },
  ]);
  expect(persisted).toEqual(attempts);
  expect(unexpected).toEqual([]);
});

test("saving edited usage closes the old reminder draft and reopening uses the updated frequency", async ({
  page,
}) => {
  const {
    form,
    attempts,
    persisted,
    medicationEdits,
    unexpected,
    openMedication,
  } = await openReminder(page, { allowMedicationEdits: true });
  await form.getByLabel("每天提醒時間").fill("8:00，20:00");
  const card = page.locator(
    `.med-card[data-medication-id="${selectedMedication.id}"]`,
  );
  await card.getByRole("button", { name: "編輯用法", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "編輯用法", exact: true }),
  ).toBeVisible();
  await page.getByLabel("頻次原文", { exact: true }).fill("TID");
  await page
    .getByRole("button", { name: "保存待核對資料", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "編輯用法", exact: true }),
  ).toHaveCount(0);
  await expect(form).toHaveCount(0);
  await expect(card.locator(".usage-box .frequency-raw")).toHaveText("TID");
  expect(medicationEdits).toHaveLength(1);
  expect(medicationEdits[0]).toMatchObject({
    medicationId: selectedMedication.id,
    input: { frequencyRaw: "TID" },
  });

  await openMedication(selectedMedication.id);
  await expect(form.getByLabel("每天提醒時間")).toHaveValue("");
  await expect(page.locator(".schedule-form")).toContainText("TID");
  await expect(page.locator(".schedule-form")).not.toContainText("BID");
  await expect(
    page.locator(
      `.med-card[data-medication-id="${medications[0].id}"] .usage-box .frequency-raw`,
    ),
  ).toHaveText("QD");
  expect(attempts).toEqual([]);
  expect(persisted).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("a failed reminder save retains input and a guarded retry persists once before closing", async ({
  page,
}) => {
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const { form, attempts, persisted, unexpected } = await openReminder(page, {
    failFirst: true,
    saveGate,
  });
  const times = form.getByLabel("每天提醒時間");
  const start = form.getByLabel("開始日期", { exact: true });
  const end = form.getByLabel("結束日期（可留白）", { exact: true });
  await times.fill("9:15，21:45");
  await start.fill("2030-02-10");
  await end.fill("2030-02-20");
  const submit = form.getByRole("button", {
    name: "確認提醒時間",
    exact: true,
  });
  await submit.click();
  await expect(form.getByRole("alert")).toContainText(
    "合成測試：服務暫時忙碌，請重試。",
  );
  await expect(times).toHaveValue("9:15，21:45");
  await expect(start).toHaveValue("2030-02-10");
  await expect(end).toHaveValue("2030-02-20");
  await expect(submit).toBeEnabled();
  expect(attempts).toHaveLength(1);
  expect(persisted).toEqual([]);

  await submit.click();
  try {
    await expect.poll(() => attempts.length).toBe(2);
    await expect(
      form.getByRole("button", { name: "儲存提醒中…", exact: true }),
    ).toBeDisabled();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(times).toBeDisabled();
    await expect(start).toBeDisabled();
    await expect(end).toBeDisabled();
    await expect(
      form.getByRole("button", { name: "取消", exact: true }),
    ).toBeDisabled();
    // Exercise the submit handler directly while its first request is pending.
    await form.dispatchEvent("submit");
    await form.dispatchEvent("submit");
    expect(attempts).toHaveLength(2);
    expect(persisted).toEqual([]);
    await expect(form).toBeVisible();
  } finally {
    releaseSave();
  }
  await expect(form).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(persisted).toEqual([
    {
      medicationId: selectedMedication.id,
      times: ["09:15", "21:45"],
      startDate: "2030-02-10",
      endDate: "2030-02-20",
    },
  ]);
  expect(unexpected).toEqual([]);
});
