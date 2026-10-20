import { jobFingerprint, PendingJobs, type PendingJob } from "./pending-jobs";

let tokenProvider: () => Promise<string> = async () => "";
export function setTokenProvider(fn: () => Promise<string>) {
  tokenProvider = fn;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId = "",
    public status = 0,
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
  return request<T>(path, method, body, key);
}
async function request<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  assertIdentity?: () => void,
): Promise<T> {
  assertIdentity?.();
  if (!navigator.onLine)
    throw new ApiError("offline", "目前離線，請連線後再操作。");
  const token = await tokenProvider();
  assertIdentity?.();
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
    assertIdentity?.();
    throw new ApiError(
      "network_error",
      "無法連線到服務，請確認連線與藥智通服務已啟動後再試。",
    );
  }
  assertIdentity?.();
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "invalid_response",
      "服務暫時無法回應，請稍後重試。",
      response.headers.get("X-Request-Id") || "",
      response.status,
    );
  }
  assertIdentity?.();
  if (!response.ok)
    throw new ApiError(
      data?.code || "service_error",
      data?.message || "服務暫時無法回應，請稍後重試。",
      data?.requestId || "",
      response.status,
    );
  return data;
}

const pendingJobs = new PendingJobs();
let jobIdentity: string | null = null;
let identityEpoch = 0;
interface InFlightJob {
  promise: Promise<any>;
  progress: Set<(message: string) => void>;
  latestProgress?: string;
}
const inFlightJobs = new Map<string, InFlightJob>();

export function setJobIdentity(identity: string | null) {
  if (identity === jobIdentity) return;
  // Initial sign-in may recover a pending operation from a page reload. An actual
  // account switch or logout discards the previous account's client-side state.
  if (jobIdentity !== null) pendingJobs.clear();
  jobIdentity = identity;
  identityEpoch++;
  inFlightJobs.clear();
}

function definitiveRejection(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  );
}

async function runJob(
  record: PendingJob,
  path: string,
  body: unknown,
  assertIdentity: () => void,
  progress: (message: string) => void,
) {
  assertIdentity();
  let jobId = record.jobId;
  if (!jobId) {
    try {
      const accepted = await request(
        path,
        "POST",
        body,
        record.key,
        assertIdentity,
      );
      if (
        typeof accepted?.jobId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(accepted.jobId)
      )
        throw new ApiError(
          "invalid_response",
          "服務暫時無法回應，請稍後重試。",
        );
      jobId = accepted.jobId as string;
      pendingJobs.rememberJob(record, jobId);
    } catch (error) {
      if (definitiveRejection(error)) pendingJobs.complete(record);
      throw error;
    }
  }
  progress("已排入處理，正在核對資料與仿單…");
  try {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 1800));
      assertIdentity();
      const job = await request(
        "/jobs/" + encodeURIComponent(jobId),
        "GET",
        undefined,
        undefined,
        assertIdentity,
      );
      if (job.status === "succeeded") {
        pendingJobs.complete(record);
        return job;
      }
      if (job.status === "failed") {
        pendingJobs.complete(record);
        throw new ApiError(
          job.error?.code || "job_failed",
          job.error?.message || "背景工作未完成，請到處理紀錄查看。",
        );
      }
      progress(
        job.status === "running"
          ? "正在核對內容與引用，背景工作持續處理中…"
          : "已排入處理，請稍候…",
      );
    }
    throw new ApiError("timeout", "背景工作仍在處理，請稍後到紀錄查看。");
  } catch (error) {
    throw Object.assign(
      error instanceof Error
        ? error
        : new ApiError("job_failed", "背景工作未完成。"),
      { jobId },
    );
  }
}

export async function submitJob(
  path: string,
  body: unknown,
  onProgress?: (message: string) => void,
) {
  if (!navigator.onLine)
    throw new ApiError("offline", "目前離線，請連線後再操作。");
  const identity = jobIdentity;
  const epoch = identityEpoch;
  const assertIdentity = () => {
    if (!identity || identity !== jobIdentity || epoch !== identityEpoch)
      throw new ApiError(
        "identity_changed",
        "登入帳號已變更，請重新開啟處理紀錄。",
      );
  };
  assertIdentity();
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    );
  } catch {
    throw new ApiError(
      "invalid_request",
      "送出的資料格式無法確認，請重新操作。",
    );
  }
  if (serialized === undefined)
    throw new ApiError(
      "invalid_request",
      "送出的資料格式無法確認，請重新操作。",
    );
  const requestBody: unknown = JSON.parse(serialized);
  const [ownerHash, fingerprint] = await Promise.all([
    jobFingerprint(identity!),
    jobFingerprint(path + "\n" + serialized),
  ]);
  assertIdentity();
  const flightKey = ownerHash + ":" + fingerprint;
  const existing = inFlightJobs.get(flightKey);
  if (existing) {
    if (onProgress) {
      existing.progress.add(onProgress);
      if (existing.latestProgress) {
        try {
          onProgress(existing.latestProgress);
        } catch {
          /* A view cannot restart a background job. */
        }
      }
    }
    return existing.promise;
  }
  const record =
    pendingJobs.get(ownerHash, fingerprint) ||
    pendingJobs.create(ownerHash, fingerprint);
  if (!record)
    throw new ApiError(
      "pending_limit",
      "尚有多筆未完成的操作，請先到處理紀錄確認。",
    );
  const listeners = new Set(onProgress ? [onProgress] : []);
  let latestProgress: string | undefined;
  const flight: InFlightJob = {
    progress: listeners,
    get latestProgress() {
      return latestProgress;
    },
    promise: runJob(record, path, requestBody, assertIdentity, (message) => {
      latestProgress = message;
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          /* A view cannot restart a background job. */
        }
      }
    }).finally(() => {
      if (inFlightJobs.get(flightKey) === flight)
        inFlightJobs.delete(flightKey);
    }),
  };
  inFlightJobs.set(flightKey, flight);
  return flight.promise;
}
export async function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
