/** Explicit real-model retry on an isolated copy of synthetic browser-test data. */
import { readFile, writeFile } from "node:fs/promises";
import { MemoryStore } from "../server/store.js";
import { Domain } from "../server/domain.js";
import { createApp } from "../server/app.js";
import { localToken } from "../server/auth.js";
import { GROUNDING_VERSION } from "../server/ai.js";
const input = process.argv[2];
if (!/^\.local\/real-ai-\d+\/db\.json$/.test(input || ""))
  throw Error("Use an isolated real-ai test database");
const source = JSON.parse(await readFile(input, "utf8"));
const store = new MemoryStore();
store.data = structuredClone(source);
const main = JSON.parse(await readFile(".local/db.json", "utf8"));
const drugs = JSON.parse(
  await readFile(".local/blobs/" + main.settings.catalog.path, "utf8"),
);
const d = new Domain(store);
d.catalog.all = async () => drugs;
const app = createApp(d),
  token = localToken("local-owner");
const report: any = {
  createdAt: new Date().toISOString(),
  syntheticContext: true,
  copiedFrom: input,
  promptVersion: GROUNDING_VERSION,
  steps: [],
};
const call = async (path: string, body: unknown) => {
  const r = await app.request("/api/v1" + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error("Test API response: " + r.status);
  return r.json();
};
try {
  const chat: any = (await store.list("jobs")).find(
    (j) => j.kind === "chat" && j.status === "failed",
  );
  if (!chat) throw Error("No failed synthetic chat to retry");
  await call("/jobs/" + chat.id + "/retry", {});
  await d.processJob(chat.id);
  const retried = (await store.get("jobs", chat.id))!;
  report.steps.push({
    step: "original-chat-retry",
    passed: retried.status === "succeeded",
    priorError: chat.error?.code,
    error: retried.error?.code,
    attempts: retried.attempts,
    resultStatus: retried.result?.status,
    tokens: retried.tokens,
    latencyMs: retried.latencyMs,
  });
  const ids = (await store.list("medications", ["ownerId", "local-owner"]))
    .filter((m) => !m.archived)
    .map((m) => m.id);
  const queued: any = await call("/interactions", { medicationIds: ids });
  await d.processJob(queued.jobId);
  const interaction = (await store.get("jobs", queued.jobId))!;
  const passed =
    interaction.status === "succeeded" &&
    ["not_found", "insufficient_data"].includes(interaction.result?.status) &&
    interaction.result.claims.length === 0;
  report.steps.push({
    step: "pair-scope-real-model",
    passed,
    status: interaction.status,
    resultStatus: interaction.result?.status,
    claims: interaction.result?.claims?.length,
    error: interaction.error?.code,
    tokens: interaction.tokens,
    latencyMs: interaction.latencyMs,
  });
  report.status = report.steps.every((s: any) => s.passed)
    ? "passed"
    : "failed";
} catch (e: any) {
  report.status = "failed";
  report.error = e.message;
}
await writeFile(
  ".local/reports/local-ai-recovery.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
