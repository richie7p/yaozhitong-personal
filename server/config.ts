export const config = {
  mode: process.env.APP_MODE || "local",
  project: process.env.GOOGLE_CLOUD_PROJECT || "",
  bucket: process.env.STORAGE_BUCKET || "",
  port: Number(process.env.PORT || 8080),
  localPath: process.env.LOCAL_DATA_PATH || ".local",
  textModel:
    process.env.NVIDIA_TEXT_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b",
  visionModel:
    process.env.NVIDIA_VISION_MODEL ||
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  nvidiaBase:
    process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
  nvidiaKey: (process.env.NVIDIA_API_KEY || "").trim(),
  userLimit: Number(process.env.DAILY_USER_LIMIT || 20),
  globalLimit: Number(process.env.DAILY_GLOBAL_LIMIT || 200),
  workerUrl: process.env.WORKER_URL || "",
  workerEmail: process.env.WORKER_SERVICE_ACCOUNT || "",
  location: process.env.TASKS_LOCATION || "asia-east1",
  queue: process.env.TASKS_QUEUE || "yaozhitong-ai",
  appUrl: process.env.APP_URL || "http://localhost:5173",
  role: process.env.SERVICE_ROLE || "web",
};
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
