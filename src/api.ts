import { jobFingerprint, PendingJobs, type PendingJob } from "./pending-jobs";
import { setChatDraftIdentity } from "./chat-draft";

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
  phase?: "token" | "headers" | "body";
  attempts?: number;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  assertIdentity?: () => void,
): Promise<T> {
  return request<T>(path, method, body, key, assertIdentity);
}
async function request<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  assertIdentity?: () => void,
): Promise<T> {
  const epoch = identityEpoch;
  assertIdentity?.();
  if (!navigator.onLine)
    throw new ApiError("offline", "目前離線，請連線後再操作。");
  // Queued AI processing has its own polling budget. Bound the transport too:
  // a stalled token refresh, upload or response body must not leave a view busy.
  const timeoutMs =
    path === "/recognitions" && method === "POST" ? 90000 : 45000;
  const controller = new AbortController();
  let timedOut = false;
  let phase: "token" | "headers" | "body" = "token";
  let attempts = 0;
  let clientRequestId = crypto.randomUUID();
  const timeoutError = new ApiError(
    "request_timeout",
    "連線等待過久，請確認網路後重試；已送出的操作可先到相關紀錄確認。",
  );
  const assertActive = () => {
    assertIdentity?.();
    if (epoch !== identityEpoch)
      throw new ApiError(
        "identity_changed",
        "登入帳號已變更，請重新開啟頁面。",
      );
    if (timedOut) throw timeoutError;
  };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutError.requestId = clientRequestId;
      timeoutError.phase = phase;
      timeoutError.attempts = attempts;
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });
  const operation = (async () => {
    const token = await tokenProvider();
    // A token refresh may finish after the caller has timed out. Never send
    // that late request, especially when it contains a photo or other input.
    assertActive();
    for (;;) {
      assertActive();
      attempts++;
      if (attempts > 1) clientRequestId = crypto.randomUUID();
      phase = "headers";
      const attemptController = new AbortController();
      let headersActive = true;
      let headerTimer: ReturnType<typeof setTimeout> | undefined;
      const cancelAttempt = () => {
        headersActive = false;
        clearTimeout(headerTimer);
        attemptController.abort();
      };
      controller.signal.addEventListener("abort", cancelAttempt, {
        once: true,
      });
      try {
        let response: Response;
        try {
          // A silent first connection must leave time for the one safe read
          // retry. This header-only sub-budget starts after token refresh;
          // the original 45-second total deadline still covers both attempts
          // and the full body. Mutations never receive a second attempt.
          const headerDeadline =
            method === "GET" && attempts === 1
              ? new Promise<never>((_resolve, reject) => {
                  headerTimer = setTimeout(() => {
                    headersActive = false;
                    reject(new Error("read_header_timeout"));
                    attemptController.abort();
                  }, 15000);
                })
              : undefined;
          const fetching = fetch("/api/v1" + path, {
            method,
            headers: {
              ...(token ? { Authorization: "Bearer " + token } : {}),
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...(key ? { "Idempotency-Key": key } : {}),
              "X-Client-Request-Id": clientRequestId,
            },
            body: body ? JSON.stringify(body) : undefined,
            cache: "no-store",
            signal: attemptController.signal,
          }).then((next) => {
            if (!headersActive) {
              // A transport can ignore cancellation. Release its late body,
              // and never let the obsolete response win against recovery.
              void next.body?.cancel().catch(() => {});
              throw new Error("obsolete_read_attempt");
            }
            return next;
          });
          response = headerDeadline
            ? await Promise.race([fetching, headerDeadline])
            : await fetching;
        } catch {
          assertActive();
          // Only a failed transport for a read can retry. The original total
          // deadline includes both attempts and token refresh; mutations never retry.
          if (method === "GET" && attempts === 1 && navigator.onLine) continue;
          throw Object.assign(
            new ApiError(
              "network_error",
              "無法連線到服務，請確認連線與藥智通服務已啟動後再試。",
              clientRequestId,
            ),
            { phase, attempts },
          );
        }
        clearTimeout(headerTimer);
        assertActive();
        phase = "body";
        let data: any;
        try {
          data = await response.json();
        } catch (error) {
          assertActive();
          if (
            error instanceof TypeError &&
            method === "GET" &&
            attempts === 1 &&
            navigator.onLine
          )
            continue;
          throw new ApiError(
            "invalid_response",
            "服務暫時無法回應，請稍後重試。",
            response.headers.get("X-Request-Id") || "",
            response.status,
          );
        }
        assertActive();
        if (!response.ok)
          throw new ApiError(
            data?.code || "service_error",
            data?.message || "服務暫時無法回應，請稍後重試。",
            data?.requestId || "",
            response.status,
          );
        return data as T;
      } finally {
        headersActive = false;
        clearTimeout(headerTimer);
        controller.signal.removeEventListener("abort", cancelAttempt);
      }
    }
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer!);
  }
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
  setChatDraftIdentity(identity);
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
  // Register before hashing: a matching caller's slower digest must not start
  // another operation after this one completes. This exact input key stays in
  // memory only; pending-job storage still contains hashes and identifiers.
  const flightKey = JSON.stringify([identity, epoch, path]) + "\n" + serialized;
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
  const listeners = new Set(onProgress ? [onProgress] : []);
  let latestProgress: string | undefined;
  const flight: InFlightJob = {
    progress: listeners,
    get latestProgress() {
      return latestProgress;
    },
    promise: (async () => {
      const [ownerHash, fingerprint] = await Promise.all([
        jobFingerprint(identity!),
        jobFingerprint(path + "\n" + serialized),
      ]);
      assertIdentity();
      const record =
        pendingJobs.get(ownerHash, fingerprint) ||
        pendingJobs.create(ownerHash, fingerprint);
      if (!record)
        throw new ApiError(
          "pending_limit",
          "尚有多筆未完成的操作，請先到處理紀錄確認。",
        );
      return runJob(record, path, requestBody, assertIdentity, (message) => {
        latestProgress = message;
        for (const listener of listeners) {
          try {
            listener(message);
          } catch {
            /* A view cannot restart a background job. */
          }
        }
      });
    })().finally(() => {
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
