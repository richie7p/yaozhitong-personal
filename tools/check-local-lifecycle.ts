/** Real local server restart and account removal in a fresh, isolated directory. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { MemoryStore } from "../server/store.js";
import { hash } from "../server/domain.js";
const directory = `.local/lifecycle-${Date.now()}`;
const port = 5194,
  base = `http://127.0.0.1:${port}`;
let child: ChildProcess | undefined;
const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  isolatedDirectory: directory,
  synthetic: true,
};
async function start() {
  child = spawn(process.execPath, ["dist/server/index.mjs"], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      APP_MODE: "local",
      PORT: String(port),
      LOCAL_DATA_PATH: directory,
      NVIDIA_API_KEY: "",
      NODE_ENV: "",
    },
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(base + "/health")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
  child = undefined;
}
async function login() {
  return (
    await (
      await fetch(base + "/api/v1/auth/local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: "local-owner" }),
      })
    ).json()
  ).token;
}
let browser;
try {
  await start();
  let token = await login();
  const call = (path: string, method = "GET", data?: unknown) =>
    fetch(base + "/api/v1" + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const meds = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      call("/medications", "POST", {
        name: "重啟合成藥品 " + i,
        doseAmount: 1,
        doseUnit: "錠",
        frequencyRaw: "QD",
        confirmed: true,
      }).then((r) => {
        expect(r.status).toBe(201);
        return r.json();
      }),
    ),
  );
  await call("/me", "PUT", { displayName: "重啟測試", notes: "僅供軟體測試" });
  await stop();
  // Simulate a process ending between durable job creation and queue dispatch.
  const store = await new MemoryStore(directory + "/db.json").load();
  for (const status of ["queued", "running"])
    await store.set("jobs", "recover-" + status, {
      id: "recover-" + status,
      ownerId: "local-owner",
      kind: "bundle",
      status,
      input: { medicationIds: [meds[0].id] },
      result: null,
      error: null,
      attempts: status === "running" ? 1 : 0,
      leaseUntil: Date.now() - 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  await start();
  expect((await call("/me")).status).toBe(401);
  token = await login();
  expect((await (await call("/medications")).json()).items.length).toBe(12);
  expect((await (await call("/me")).json()).profile.notes).toBe("僅供軟體測試");
  for (const status of ["queued", "running"])
    await expect
      .poll(
        async () =>
          (await (await call("/jobs/recover-" + status)).json()).status,
        { timeout: 10000 },
      )
      .toBe("succeeded");
  report.restart = {
    medicationsPreserved: 12,
    profilePreserved: true,
    oldTokenRejected: true,
    queuedJobRecovered: true,
    expiredRunningJobRecovered: true,
  };
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole("button", { name: "本機使用者", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天也照顧好自己/ }),
  ).toBeVisible();
  await page.goto(base + "/#profile");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "刪除帳號", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /看懂每一顆藥/ }),
  ).toBeVisible();
  expect((await call("/me")).status).toBe(403);
  await expect
    .poll(
      async () =>
        (await store.list("medications", ["ownerId", "local-owner"])).length,
    )
    .toBe(0);
  await expect
    .poll(async () => await store.get("jobs", "delete-" + hash("local-owner")))
    .toBeNull();
  const db = JSON.parse(await readFile(directory + "/db.json", "utf8"));
  expect(db.profiles?.["local-owner"]).toBeUndefined();
  expect(Object.values(db.chats || {}).length).toBe(0);
  report.accountDeletion = {
    browserLogout: true,
    oldTokenRejected: true,
    privateDataCleared: true,
  };
  report.status = "passed";
} catch (e: any) {
  report.status = "failed";
  report.error = e.message;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop();
}
await mkdir(".local/reports", { recursive: true });
await writeFile(
  ".local/reports/local-lifecycle.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
