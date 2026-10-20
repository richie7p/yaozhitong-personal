const provider = process.env.AI_PROVIDER || "nvidia";
if (provider !== "nvidia" && provider !== "openai")
  throw new Error("AI_PROVIDER must be nvidia or openai.");
const bounded = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}.`);
  return Math.floor(value);
};
const fallbackModels = (name: string) => {
  const models = [
    ...new Set(
      (process.env[name] || "")
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  if (
    models.length > 2 ||
    models.some((model) => !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(model))
  )
    throw new Error(
      `${name} must contain at most two NVIDIA model IDs separated by commas.`,
    );
  return models;
};
export const config = {
  mode: process.env.APP_MODE || "local",
  project: process.env.GOOGLE_CLOUD_PROJECT || "",
  bucket: process.env.STORAGE_BUCKET || "",
  googleOAuthClientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
  port: Number(process.env.PORT || 8080),
  localPath: process.env.LOCAL_DATA_PATH || ".local",
  aiProvider: provider as "nvidia" | "openai",
  textModel:
    process.env.AI_TEXT_MODEL ||
    (provider === "openai"
      ? process.env.OPENAI_TEXT_MODEL || "gpt-6-luna"
      : process.env.NVIDIA_TEXT_MODEL ||
        "nvidia/nemotron-3.5-super-vl-120b-a12b"),
  visionModel:
    process.env.AI_VISION_MODEL ||
    (provider === "openai"
      ? process.env.OPENAI_VISION_MODEL || "gpt-6-luna"
      : process.env.NVIDIA_VISION_MODEL ||
        "nvidia/nemotron-3.5-super-vl-120b-a12b"),
  nvidiaBase:
    process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
  nvidiaKey: (process.env.NVIDIA_API_KEY || "").trim(),
  openaiBase: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiKey: (process.env.OPENAI_API_KEY || "").trim(),
  aiRequestTimeoutMs: bounded("AI_REQUEST_TIMEOUT_MS", 45000, 1000, 90000),
  aiPrimaryTimeoutMs: bounded("AI_PRIMARY_TIMEOUT_MS", 22000, 1000, 45000),
  aiTextPrimaryTimeoutMs: bounded(
    "AI_TEXT_PRIMARY_TIMEOUT_MS",
    12000,
    1000,
    45000,
  ),
  nvidiaTextFallbackModels: fallbackModels("NVIDIA_TEXT_FALLBACK_MODELS"),
  nvidiaVisionFallbackModels: fallbackModels("NVIDIA_VISION_FALLBACK_MODELS"),
  aiJobTimeoutMs: bounded("AI_JOB_TIMEOUT_MS", 120000, 1000, 300000),
  aiTextMaxTokens: bounded("AI_TEXT_MAX_TOKENS", 2400, 256, 6000),
  aiVisionMaxTokens: bounded("AI_VISION_MAX_TOKENS", 2600, 512, 6000),
  userLimit: Number(process.env.DAILY_USER_LIMIT || 20),
  globalLimit: Number(process.env.DAILY_GLOBAL_LIMIT || 200),
  workerUrl: process.env.WORKER_URL || "",
  workerEmail: process.env.WORKER_SERVICE_ACCOUNT || "",
  location: process.env.TASKS_LOCATION || "asia-east1",
  queue: process.env.TASKS_QUEUE || "yaozhitong-ai",
  appUrl: process.env.APP_URL || "http://localhost:5173",
  role: process.env.SERVICE_ROLE || "web",
};
export function aiConnection() {
  return config.aiProvider === "openai"
    ? { key: config.openaiKey, base: config.openaiBase, label: "OpenAI" }
    : { key: config.nvidiaKey, base: config.nvidiaBase, label: "NVIDIA" };
}
export function aiModelRoute(vision = false) {
  const primary = vision ? config.visionModel : config.textModel;
  return [
    ...new Set([
      primary,
      ...(config.aiProvider === "nvidia"
        ? vision
          ? config.nvidiaVisionFallbackModels
          : config.nvidiaTextFallbackModels
        : []),
    ]),
  ];
}
export function aiRoutingIdentity() {
  return {
    policy:
      config.aiProvider === "openai"
        ? "openai-chat-json-none-v2"
        : "nvidia-fallback-v2",
    sourceMentions: "literal-conditions-v1",
    doseTranscription: "literal-dose-text-v1",
    textModels: aiModelRoute(),
    visionModels: aiModelRoute(true),
    requestTimeoutMs: config.aiRequestTimeoutMs,
    primaryTimeoutMs: config.aiPrimaryTimeoutMs,
    textPrimaryTimeoutMs: config.aiTextPrimaryTimeoutMs,
    jobTimeoutMs: config.aiJobTimeoutMs,
    textMaxTokens: config.aiTextMaxTokens,
  };
}
if (
  (process.env.K_SERVICE || process.env.NODE_ENV === "production") &&
  config.mode !== "firebase"
)
  throw new Error(
    "Production requires APP_MODE=firebase; local authentication is forbidden.",
  );
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new AppError(code, message, status);
};
