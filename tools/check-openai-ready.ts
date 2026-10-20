/** Local preparation checks only. No provider requests, key output or data changes. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { config } from "../server/config.js";

const targetModel = "gpt-6-luna";
const textModel =
  process.env.AI_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || targetModel;
const visionModel =
  process.env.AI_VISION_MODEL || process.env.OPENAI_VISION_MODEL || targetModel;
const blockers: string[] = [];
const checks: { name: string; passed: boolean; message: string }[] = [];
const check = (name: string, passed: boolean, message: string) => {
  checks.push({ name, passed, message });
  if (!passed) blockers.push(message);
};

check(
  "selected-models",
  textModel === targetModel && visionModel === targetModel,
  "OpenAI 文字與影像都須使用 gpt-6-luna；請檢查通用 AI_TEXT_MODEL／AI_VISION_MODEL 是否仍覆寫舊模型。",
);
let officialEndpoint = false;
try {
  const url = new URL(config.openaiBase);
  officialEndpoint =
    url.origin === "https://api.openai.com" &&
    url.pathname.replace(/\/$/, "") === "/v1" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
} catch {}
check(
  "official-endpoint",
  officialEndpoint,
  "OPENAI_BASE_URL 須為官方 https://api.openai.com/v1。",
);
let ignored = false;
try {
  execFileSync("git", ["check-ignore", "--quiet", ".env"], {
    windowsHide: true,
    stdio: "ignore",
  });
  ignored = true;
} catch {}
check("ignored-key-file", ignored, ".env 須排除於版本控制之外。");
let built = false;
try {
  const [web, server] = await Promise.all([
    stat("dist/web/index.html"),
    readFile("dist/server/index.mjs", "utf8"),
  ]);
  built =
    web.isFile() &&
    server.includes(targetModel) &&
    server.includes("openai-chat-json-none-v2");
} catch {}
check("prepared-build", built, "請先完成本次 GPT-6 Luna 版本建置。");

const keyConfigured = Boolean(config.openaiKey);
const activated = config.aiProvider === "openai";
if (activated)
  check(
    "active-models",
    config.textModel === targetModel && config.visionModel === targetModel,
    "啟用中的文字與影像模型須為 gpt-6-luna。",
  );
const status = blockers.length
  ? "blocked_preparation"
  : !keyConfigured
    ? "prepared_pending_key"
    : !activated
      ? "prepared_pending_activation"
      : "prepared_pending_real_acceptance";
const report = {
  checkedAt: new Date().toISOString(),
  check: "openai-luna-local-preparation",
  status,
  targetModel,
  activeProvider: config.aiProvider,
  stagedOpenAIModels: { text: textModel, vision: visionModel },
  keyConfigured,
  keyValidityVerified: false,
  realAiCalls: 0,
  liveAcceptance: "not_run",
  activationRequired: !activated,
  canStartOptInRealAcceptance: !blockers.length && keyConfigured && activated,
  requestPolicy: {
    endpoint: "chat/completions",
    reasoningEffort: "none",
    store: false,
    responseFormat: "json_object",
    requestTimeoutMs: config.aiRequestTimeoutMs,
    jobTimeoutMs: config.aiJobTimeoutMs,
    crossProviderFallback: false,
  },
  checks,
  blockers,
  pending: [
    ...(!keyConfigured ? ["在 .env 設定 OPENAI_API_KEY。"] : []),
    ...(!activated ? ["金鑰到位後改 AI_PROVIDER=openai 並重新啟動服務。"] : []),
    "尚須真實驗證帳戶權限與額度，再連續完成五輪三段流程、來源核對及失敗恢復驗收。",
  ],
  note: "只檢查本機準備狀態；金鑰存在不代表權限、額度或模型品質已驗證。",
};
if (!process.argv.includes("--no-report")) {
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/openai-readiness.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
if (
  blockers.length ||
  (process.argv.includes("--require-key") && !keyConfigured)
)
  process.exitCode = 1;
