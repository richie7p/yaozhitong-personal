// Opt-in expanded acceptance trace. Input photos are hashed; never record headers or image bytes.
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.SEMINAR_AI_TRACE_DIR;
if (!directory) throw Error("An isolated acceptance directory is required.");
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set([
  "https://integrate.api.nvidia.com",
  "https://api.openai.com",
]);
let sequence = 0;
const pending = new Set();
const knownSecrets = new Set(
  [process.env.NVIDIA_API_KEY, process.env.OPENAI_API_KEY]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 8),
);
function redactCredentials(value) {
  if (typeof value === "string") {
    for (const secret of knownSecrets)
      value = value.split(secret).join("[credential redacted]");
    // Authentication errors may echo a masked key rather than the exact value.
    return value.replace(
      /\b(?:sk|nvapi)-[A-Za-z0-9_.…*_-]+/gi,
      "[credential redacted]",
    );
  }
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactCredentials(item),
      ]),
    );
  return value;
}
function track(task) {
  pending.add(task);
  task.then(
    () => pending.delete(task),
    () => pending.delete(task),
  );
}
// Diagnostic tests may await completion; application requests never await tracing.
export async function flushSeminarAiTraces() {
  return Promise.allSettled([...pending]);
}
async function save(entry, started, number) {
  entry.latencyMs = Date.now() - started;
  const file = join(
    directory,
    `upstream-${String(number).padStart(2, "0")}.json`,
  );
  await writeFile(
    file + ".tmp",
    JSON.stringify(redactCredentials(entry), null, 2),
  );
  await rename(file + ".tmp", file);
}
async function captureBody(response, entry, started, number) {
  try {
    entry.response = await response.json();
    entry.usage = entry.response.usage;
    entry.finishReason = entry.response.choices?.[0]?.finish_reason;
  } catch {
    entry.unreadableResponse = true;
  } finally {
    await save(entry, started, number);
  }
}
function redactImages(value) {
  if (typeof value === "string" && value.startsWith("data:image/"))
    return {
      inputImageRedacted: true,
      dataUrlSha256: createHash("sha256").update(value).digest("hex"),
    };
  if (Array.isArray(value)) return value.map(redactImages);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactImages(item)]),
    );
  return value;
}
globalThis.fetch = async (...args) => {
  const url = new URL(
    typeof args[0] === "string" || args[0] instanceof URL
      ? String(args[0])
      : args[0].url,
  );
  if (!allowedOrigins.has(url.origin)) return originalFetch(...args);
  // Inspect a credential only to redact a provider echo; never retain headers.
  const headers = new Headers(
    args[1]?.headers ||
      (args[0] instanceof Request ? args[0].headers : undefined),
  );
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && bearer.length >= 8) knownSecrets.add(bearer);
  const started = Date.now();
  const number = ++sequence;
  const entry = {
    sequence: number,
    startedAt: new Date(started).toISOString(),
    endpoint: url.origin + url.pathname,
    syntheticPatient: true,
    mockedAI: false,
  };
  try {
    entry.request = redactImages(JSON.parse(String(args[1]?.body || "{}")));
  } catch {
    entry.requestUnreadable = true;
  }
  try {
    const response = await originalFetch(...args);
    entry.status = response.status;
    entry.requestId = response.headers.get("x-request-id");
    // Return headers immediately, matching normal fetch. Reading the diagnostic
    // clone must not hold the application's body reader behind a second read.
    track(captureBody(response.clone(), entry, started, number));
    return response;
  } catch (error) {
    entry.error = {
      name: error?.name || "Error",
      message: error?.message || "Unknown upstream error",
    };
    track(save(entry, started, number));
    throw error;
  }
};
