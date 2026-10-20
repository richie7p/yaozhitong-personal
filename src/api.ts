let tokenProvider: () => Promise<string> = async () => "";
export function setTokenProvider(fn: () => Promise<string>) {
  tokenProvider = fn;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId = "",
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  if (!navigator.onLine)
    throw new ApiError("offline", "目前離線，請連線後再操作。");
  const token = await tokenProvider();
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "network_error",
      "無法連線到服務，請確認連線與藥智通服務已啟動後再試。",
    );
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "invalid_response",
      "服務暫時無法回應，請稍後重試。",
      response.headers.get("X-Request-Id") || "",
    );
  }
  if (!response.ok)
    throw new ApiError(
      data?.code || "service_error",
      data?.message || "服務暫時無法回應，請稍後重試。",
      data?.requestId || "",
    );
  return data;
}
export async function submitJob(
  path: string,
  body: unknown,
  onProgress?: (message: string) => void,
) {
  const key = crypto.randomUUID();
  const { jobId } = await api(path, "POST", body, key);
  onProgress?.("已排入處理，正在核對資料與仿單…");
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 1800));
    const job = await api("/jobs/" + jobId);
    if (job.status === "succeeded") return job;
    if (job.status === "failed")
      throw Object.assign(new ApiError(job.error.code, job.error.message), {
        jobId,
      });
    onProgress?.(
      job.status === "running"
        ? "正在核對內容與引用，背景工作持續處理中…"
        : "已排入處理，請稍候…",
    );
  }
  throw new ApiError("timeout", "背景工作仍在處理，請稍後到紀錄查看。");
}
export async function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
