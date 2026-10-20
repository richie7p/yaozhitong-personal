/** Real local-process crash/restart and controlled upstream failure acceptance.
 * All patient, leaflet and model data are synthetic; no external AI is called.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { MemoryStore } from "../server/store.js";
import { hash } from "../server/domain.js";
import { GROUNDING_VERSION } from "../server/ai.js";

const recoveryProvider = process.env.RECOVERY_AI_PROVIDER || "nvidia";
if (recoveryProvider !== "nvidia" && recoveryProvider !== "openai")
  throw Error("RECOVERY_AI_PROVIDER must be nvidia or openai.");
const recoveryTextModel =
  recoveryProvider === "openai"
    ? "gpt-6-luna"
    : process.env.NVIDIA_TEXT_MODEL || "nvidia/nemotron-3.5-super-vl-120b-a12b";
const recoveryVisionModel =
  recoveryProvider === "openai"
    ? "gpt-6-luna"
    : process.env.NVIDIA_VISION_MODEL ||
      "nvidia/nemotron-3.5-super-vl-120b-a12b";
const syntheticCredential =
  "synthetic-local-" + recoveryProvider + "-stub-only";
const directory = `.local/seminar-recovery-${recoveryProvider}-${Date.now()}`;
const port = 5197,
  base = `http://127.0.0.1:${port}`;
const report: any = {
  createdAt: new Date().toISOString(),
  directory,
  synthetic: true,
  mockedAI: true,
  provider: recoveryProvider,
  textModel: recoveryTextModel,
  visionModel: recoveryVisionModel,
  modelExecution: "synthetic-loopback-fixture",
  modelAvailabilityVerified: false,
  scope:
    "The real local application and crash/restart handling use the selected provider request contract against a synthetic loopback responder. No hosted model or API availability is validated.",
  realAiCalls: 0,
  osRebootTested: false,
  steps: [],
  upstreamRequests: [],
  serverStarts: [],
};
let child: ChildProcess | undefined,
  token = "",
  serverLog = "";
let mode: "normal" | "hold" | "timeout" | "busy" | "flaky" = "normal";
let flakyRemaining = 0;
const store = new MemoryStore(directory + "/db.json");
const drugs = [1, 2].map((n) => ({
  licenseNo: `SYNTHETIC-RECOVERY-${n}`,
  nameZh: `合成恢復測試片 ${n}`,
  nameEn: `Recovery fixture ${n}`,
  strength: "",
  form: "錠",
  ingredients: ["synthetic-only"],
  revoked: false,
}));
const quote =
  "適應症：本資料僅供軟體流程驗證與教學演示。\n注意事項：本文件完全為合成資料，不可作為用藥依據。";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3aEAAAAASUVORK5CYII=";
const original = await readFile(".local/db.json");
report.mainDatabaseBefore = hash(original);
const upstream = createServer(async (req, res) => {
  try {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p);
    const body = JSON.parse(Buffer.concat(parts).toString());
    const input = body.messages[1].content;
    const parsed = Array.isArray(input) ? null : JSON.parse(input);
    const stage = Array.isArray(input)
      ? "vision"
      : parsed.expectedIds
        ? "verification"
        : "generation";
    const expectedTokens =
      stage === "vision"
        ? 2600
        : stage === "verification"
          ? Math.min(1600, Math.max(256, 100 + parsed.expectedIds.length * 45))
          : 2400;
    const contractChecks = {
      expectedModel:
        body.model ===
        (stage === "vision" ? recoveryVisionModel : recoveryTextModel),
      selectedSyntheticCredentialOnly:
        req.headers.authorization === "Bearer " + syntheticCredential,
      ...(recoveryProvider === "openai"
        ? {
            jsonObject: body.response_format?.type === "json_object",
            reasoningNone: body.reasoning_effort === "none",
            storageDisabled: body.store === false,
            completionTokenBudget:
              body.max_completion_tokens === expectedTokens,
            noNvidiaParameters:
              !("max_tokens" in body) && !("chat_template_kwargs" in body),
          }
        : {
            nvidiaTokenBudget: body.max_tokens === expectedTokens,
            noOpenaiTokenParameter: !("max_completion_tokens" in body),
          }),
    };
    const entry = {
      stage,
      mode,
      model: body.model,
      contractChecks,
      at: new Date().toISOString(),
    };
    report.upstreamRequests.push(entry);
    const failedChecks = Object.entries(contractChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length)
      throw Error(
        "Synthetic provider contract failed: " + failedChecks.join(", "),
      );
    if (mode === "hold" || mode === "timeout") return;
    if (mode === "busy" || (mode === "flaky" && flakyRemaining-- > 0)) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "synthetic temporary outage" }));
      return;
    }
    let result: any;
    if (stage === "vision")
      result = {
        status: "succeeded",
        medications: drugs.map((d) => ({
          name: d.nameZh,
          strength: "",
          form: "錠",
          doseAmount: 1,
          doseUnit: "錠",
          frequencyRaw: "QD",
          route: "口服",
          durationDays: 7,
          rawText: `合成軟體測試藥袋：${d.nameZh} 每次1錠 QD 口服 7天`,
          confidence: "high",
        })),
      };
    else if (stage === "verification")
      result = {
        verdicts: parsed.expectedIds.map((id: string) => ({
          id,
          supported: true,
        })),
      };
    else {
      const source = parsed.sources.find(
        (s: any) => s.sourceSection === "適應症",
      );
      if (!source) throw Error("Synthetic purpose source missing");
      const citations = [{ sourceId: source.id }];
      result = {
        status: "supported",
        claims: [
          {
            text: "本資料僅供軟體流程驗證與教學演示。",
            category: "purpose",
            citations,
          },
        ],
        quiz: [
          {
            claimIndex: 0,
            learningObjective: "purpose",
            sourceSection: source.sourceSection,
            requiredConditions: source.requiredConditions,
            q: "依仿單適應症欄記載，此合成資料用途為何？",
            options: ["軟體流程驗證與教學演示", "決定個人的用藥方式"],
            answer: 0,
            explain: "依適應症欄記載，本資料僅供軟體流程驗證與教學演示。",
            citations,
          },
        ],
        followups: [],
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(result) },
          },
        ],
        usage: { total_tokens: 1 },
      }),
    );
  } catch (e: any) {
    report.upstreamErrors ||= [];
    report.upstreamErrors.push(e.message);
    res.writeHead(500);
    res.end("synthetic fixture error");
  }
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = (upstream.address() as any).port;
async function start() {
  const startTime = Date.now();
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      APP_MODE: "local",
      SERVICE_ROLE: "web",
      NODE_ENV: "",
      PORT: String(port),
      LOCAL_DATA_PATH: directory,
      AI_PROVIDER: recoveryProvider,
      NVIDIA_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      NVIDIA_API_KEY: recoveryProvider === "nvidia" ? syntheticCredential : "",
      OPENAI_API_KEY: recoveryProvider === "openai" ? syntheticCredential : "",
      AI_TEXT_MODEL: "",
      AI_VISION_MODEL: "",
      NVIDIA_TEXT_MODEL: recoveryProvider === "nvidia" ? recoveryTextModel : "",
      NVIDIA_VISION_MODEL:
        recoveryProvider === "nvidia" ? recoveryVisionModel : "",
      OPENAI_TEXT_MODEL: recoveryProvider === "openai" ? recoveryTextModel : "",
      OPENAI_VISION_MODEL:
        recoveryProvider === "openai" ? recoveryVisionModel : "",
      NVIDIA_TEXT_FALLBACK_MODELS: "",
      NVIDIA_VISION_FALLBACK_MODELS: "",
      AI_TEXT_MAX_TOKENS: "2400",
      AI_VISION_MAX_TOKENS: "2600",
      AI_REQUEST_TIMEOUT_MS: "4000",
      AI_JOB_TIMEOUT_MS: "12000",
      DAILY_USER_LIMIT: "100",
      DAILY_GLOBAL_LIMIT: "1000",
    },
  });
  child.stdout?.on("data", (p) => {
    serverLog += String(p);
  });
  child.stderr?.on("data", (p) => {
    serverLog += String(p);
  });
  await expect
    .poll(
      async () => {
        if (child?.exitCode !== null) throw Error("Isolated server exited");
        try {
          return (
            await fetch(base + "/health", { signal: AbortSignal.timeout(500) })
          ).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000, intervals: [50, 100, 200] },
    )
    .toBe(200);
  report.serverStarts.push({
    pid: child.pid,
    milliseconds: Date.now() - startTime,
  });
  const runtime = await (
    await fetch(base + "/api/v1/config", { signal: AbortSignal.timeout(2000) })
  ).json();
  expect(runtime.aiProvider).toBe(recoveryProvider);
  expect(runtime.aiTextModel).toBe(recoveryTextModel);
  expect(runtime.aiVisionModel).toBe(recoveryVisionModel);
  expect(runtime.aiTextFallbackModels).toEqual([]);
  expect(runtime.aiVisionFallbackModels).toEqual([]);
  report.runtime = {
    provider: runtime.aiProvider,
    textModel: runtime.aiTextModel,
    visionModel: runtime.aiVisionModel,
    textFallbackModels: runtime.aiTextFallbackModels,
    visionFallbackModels: runtime.aiVisionFallbackModels,
  };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  child = undefined;
}
async function login() {
  const response = await fetch(base + "/api/v1/auth/local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "local-owner" }),
  });
  expect(response.status).toBe(200);
  token = (await response.json()).token;
}
async function response(
  path: string,
  method = "GET",
  body?: unknown,
  key: string = crypto.randomUUID(),
) {
  return fetch(base + "/api/v1" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const r = await response(path, method, body, key);
  const parsed = await r.json();
  if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${parsed.code}`);
  return parsed;
}
async function job(id: string, status = "succeeded") {
  let latest: any;
  await expect
    .poll(
      async () => {
        latest = await call("/jobs/" + id);
        return latest.status;
      },
      { timeout: 18000, intervals: [50, 100, 200] },
    )
    .toBe(status);
  return latest;
}
async function recognize(key?: string) {
  return call(
    "/recognitions",
    "POST",
    { image: png, mediaType: "image/png" },
    key,
  );
}
async function bundle(medicationId: string, question: string, key?: string) {
  return call(
    "/bundles",
    "POST",
    { medicationIds: [medicationId], question },
    key,
  );
}
async function snapshot() {
  return {
    medications: await store.list("medications"),
    profile: await store.get("profiles", "local-owner"),
    schedules: await store.list("schedules"),
    learning: await store.list("learning"),
    generated: await store.list("generated"),
  };
}
function passed(step: string, details: object = {}) {
  report.steps.push({ step, passed: true, ...details });
}
try {
  const available = createServer();
  await new Promise<void>((done, reject) => {
    available.once("error", reject);
    available.listen(port, "127.0.0.1", () =>
      available.close((e) => (e ? reject(e) : done())),
    );
  });
  await mkdir(directory + "/blobs/catalog", { recursive: true });
  await writeFile(
    directory + "/blobs/catalog/recovery.json",
    JSON.stringify(drugs),
  );
  await store.set("settings", "catalog", {
    version: "synthetic-recovery-v1",
    path: "catalog/recovery.json",
  });
  for (const d of drugs) {
    await store.set("leaflets", d.licenseNo, {
      id: d.licenseNo,
      licenseNo: d.licenseNo,
      version: "fixture-v1",
      sha256: "synthetic",
      chunks: [
        {
          id: d.licenseNo + "-p1",
          licenseNo: d.licenseNo,
          version: "fixture-v1",
          page: 1,
          start: 0,
          text: quote,
        },
      ],
      status: "published",
      sourceUrl: "https://example.invalid/synthetic",
      checkedBy: "automated-fixture",
    });
    await store.set("published", hash(d.licenseNo), {
      leafletId: d.licenseNo,
      version: "fixture-v1",
    });
  }
  await start();
  await login();
  await call("/me", "PUT", {
    displayName: "合成恢復測試",
    age: 32,
    notes: "僅供軟體恢復驗證",
  });
  const recognition = await job((await recognize()).jobId);
  expect(recognition.result.medications).toHaveLength(2);
  const meds = [];
  for (const d of drugs)
    meds.push(
      await call("/medications", "POST", {
        name: d.nameZh,
        licenseNo: d.licenseNo,
        doseAmount: 1,
        doseUnit: "錠",
        frequencyRaw: "QD",
        confirmed: true,
      }),
    );
  await call("/schedules", "POST", {
    medicationId: meds[0].id,
    times: ["23:59"],
    startDate: "2026-10-19",
  });
  const baseline = await job(
    (await bundle(meds[0].id, "合成基準說明與測驗")).jobId,
  );
  expect(baseline.result.quiz).toHaveLength(1);
  expect((await store.get("learning", baseline.id))?.groundingVersion).toBe(
    GROUNDING_VERSION,
  );
  const q = baseline.result.quiz[0];
  await call(`/learning/${baseline.id}/answers`, "POST", {
    answers: { [q.id]: 1 },
  });
  expect(
    (await call("/learning")).items.find((x: any) => x.id === baseline.id)
      .passed,
  ).toBe(false);
  await call(`/learning/${baseline.id}/answers`, "POST", {
    answers: { [q.id]: 0 },
  });
  expect(
    (await call("/learning")).items.find((x: any) => x.id === baseline.id)
      .passed,
  ).toBe(true);
  const beforeCrash = await snapshot();
  passed("baseline-recognition-explanation-quiz", {
    medications: 2,
    quizWrongThenCorrect: true,
  });

  mode = "hold";
  const countBefore = report.upstreamRequests.length;
  const runningRecognition = (await recognize()).jobId;
  const runningBundle = (await bundle(meds[0].id, "合成執行中重啟說明")).jobId;
  const queuedBundle = (await bundle(meds[1].id, "合成排隊重啟說明")).jobId;
  await expect
    .poll(() => report.upstreamRequests.length - countBefore, {
      timeout: 3000,
      intervals: [25],
    })
    .toBe(2);
  for (const id of [runningRecognition, runningBundle]) {
    const j = await store.get("jobs", id);
    expect(j).toMatchObject({
      status: "running",
      attempts: 1,
      localWorkerPid: child!.pid,
    });
    expect(j!.leaseUntil).toBeGreaterThan(Date.now() + 500000);
  }
  expect((await store.get("jobs", queuedBundle))?.status).toBe("queued");
  await stop();
  mode = "normal";
  const recoveryStart = Date.now();
  await start();
  expect((await response("/me")).status).toBe(401);
  await login();
  for (const id of [runningRecognition, runningBundle, queuedBundle])
    await job(id);
  const afterCrash = await snapshot();
  expect(afterCrash.medications).toEqual(beforeCrash.medications);
  expect(afterCrash.profile).toEqual(beforeCrash.profile);
  expect(afterCrash.schedules).toEqual(beforeCrash.schedules);
  expect(await store.get("learning", baseline.id)).toEqual(
    beforeCrash.learning.find((x) => x.id === baseline.id),
  );
  expect(
    (await call("/jobs/" + runningRecognition)).result.medications,
  ).toHaveLength(2);
  expect((await store.get("jobs", runningRecognition))?.attempts).toBe(2);
  expect((await store.get("jobs", runningBundle))?.attempts).toBe(2);
  expect((await store.get("jobs", queuedBundle))?.attempts).toBe(1);
  expect(afterCrash.learning).toHaveLength(3);
  expect(afterCrash.generated).toHaveLength(3);
  passed("forced-process-stop-running-and-queued-recovery", {
    recoveryMilliseconds: Date.now() - recoveryStart,
    unexpiredLeaseSeconds: 540,
    recoveredRunningJobs: 2,
    recoveredQueuedJobs: 1,
    duplicateLearningRecords: 0,
    oldTokenRejected: true,
  });
  passed("crash-preserves-medications-schedules-explanation-quiz-and-answers");

  for (let repetition = 1; repetition <= 2; repetition++) {
    const preserved = await snapshot();
    const requests = report.upstreamRequests.length;
    await stop();
    await start();
    await login();
    expect(await snapshot()).toEqual(preserved);
    expect(
      (await call("/learning")).items.find((x: any) => x.id === baseline.id)
        .passed,
    ).toBe(true);
    expect(report.upstreamRequests.length).toBe(requests);
    passed("cold-start-persistence-" + repetition, { newAiRequests: 0 });
  }

  mode = "timeout";
  const failedRecognitionId = (await recognize()).jobId;
  const failedImagePath = (await store.get("jobs", failedRecognitionId))!.input
    .imagePath;
  const failedRecognition = await job(failedRecognitionId, "failed");
  expect(failedRecognition.error.code).toBe("ai_timeout");
  expect(failedRecognition.error.message).toContain("重新上傳");
  expect(failedRecognition.error.message).not.toContain("輸入已保留");
  expect((await store.get("jobs", failedRecognitionId))?.input).toEqual({});
  await expect
    .poll(async () => {
      try {
        await access(resolve(directory, "blobs", failedImagePath));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  expect(
    (await response("/jobs/" + failedRecognitionId + "/retry", "POST", {}))
      .status,
  ).toBe(400);
  mode = "normal";
  expect(
    (await job((await recognize()).jobId)).result.medications,
  ).toHaveLength(2);
  expect(await store.list("medications")).toHaveLength(2);
  passed("recognition-timeout-then-reupload", {
    noAutomaticMedicationCreation: true,
    photoInputCleared: true,
    uploadedPhotoDeleted: true,
  });

  for (const failureMode of ["timeout", "busy"] as const) {
    mode = failureMode;
    const before = await snapshot();
    const idempotencyKey = crypto.randomUUID();
    const question = "合成失敗恢復：" + failureMode;
    const failedId = (await bundle(meds[0].id, question, idempotencyKey)).jobId;
    const failed = await job(failedId, "failed");
    expect(failed.error.code).toBe(
      failureMode === "timeout" ? "ai_timeout" : "ai_busy",
    );
    expect((await snapshot()).learning).toEqual(before.learning);
    expect((await snapshot()).generated).toEqual(before.generated);
    const usage = await store.list("usage");
    expect((await bundle(meds[0].id, question, idempotencyKey)).jobId).toBe(
      failedId,
    );
    mode = "normal";
    await Promise.all([
      call(`/jobs/${failedId}/retry`, "POST", {}),
      call(`/jobs/${failedId}/retry`, "POST", {}),
    ]);
    const recovered = await job(failedId);
    expect(recovered.attempts).toBe(2);
    expect(recovered.result.quiz).toHaveLength(1);
    expect(await store.list("usage")).toEqual(usage);
    expect(await store.list("learning")).toHaveLength(
      before.learning.length + 1,
    );
    expect(await store.list("generated")).toHaveLength(
      before.generated.length + 1,
    );
    passed(`bundle-${failureMode}-same-job-retry`, {
      concurrentRetryDeduplicated: true,
      noPartialContentOnFailure: true,
      usageUnchangedByRetry: true,
    });
  }

  mode = "flaky";
  flakyRemaining = 1;
  const requestStart = report.upstreamRequests.length;
  const transient = await job(
    (await bundle(meds[1].id, "合成一次503自動恢復")).jobId,
  );
  expect(transient.attempts).toBe(1);
  expect(transient.result.quiz).toHaveLength(1);
  expect(
    report.upstreamRequests
      .slice(requestStart)
      .filter((x: any) => x.stage === "generation"),
  ).toHaveLength(2);
  passed("single-503-automatic-retry", {
    logicalJobAttempts: 1,
    generationHttpAttempts: 2,
  });
  mode = "normal";
  const finalState = await snapshot();
  await stop();
  await start();
  await login();
  expect(await snapshot()).toEqual(finalState);
  expect((await call("/jobs/" + recognition.id)).result).toEqual(
    recognition.result,
  );
  passed(
    "final-cold-start-preserves-original-recognition-and-recovered-learning",
  );
  expect(report.upstreamErrors || []).toEqual([]);
  expect(
    report.upstreamRequests.every((request: any) =>
      Object.values(request.contractChecks).every(Boolean),
    ),
  ).toBe(true);
  report.contract = {
    allRequestsMatched: true,
    requests: report.upstreamRequests.length,
    stages: [
      ...new Set(report.upstreamRequests.map((request: any) => request.stage)),
    ],
    credentialsOrHeadersRecorded: false,
  };
  report.status = "passed";
} catch (e: any) {
  report.status = "failed";
  report.error = e.stack || e.message;
  process.exitCode = 1;
} finally {
  await stop();
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
  report.mainDatabaseAfter = hash(await readFile(".local/db.json"));
  report.mainDatabaseUnchanged =
    report.mainDatabaseBefore === report.mainDatabaseAfter;
  if (!report.mainDatabaseUnchanged) {
    report.status = "failed";
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(directory + "/server.log", serverLog);
  await writeFile(directory + "/report.json", JSON.stringify(report, null, 2));
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/seminar-recovery.json",
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    `.local/reports/seminar-recovery-${recoveryProvider}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        passed: report.steps.length,
        report: resolve(directory, "report.json"),
        error: report.error,
      },
      null,
      2,
    ),
  );
}
