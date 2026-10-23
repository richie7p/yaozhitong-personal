import { z } from "zod";
import { randomUUID } from "node:crypto";

export const CLOUD_READ_PATHS = [
  "/me",
  "/medications",
  "/schedules",
  "/today",
  "/jobs",
  "/learning",
  "/chat",
  "/notifications",
  "/support",
] as const;

const Profile = z
  .object({
    virtualUsers: z.number().int().min(1).max(100),
    requests: z.number().int().min(1).max(6000),
    thinkTimeMs: z.number().int().min(0).max(2000),
  })
  .strict();
export const LoadPlanSchema = z
  .object({
    schema: z.literal("yzt-load-plan/v1"),
    mode: z.enum(["emulator", "cloud-readonly"]),
    project: z.string().regex(/^[a-z][a-z0-9-]{5,50}$/),
    origin: z.string().url(),
    profiles: z.array(Profile).min(1).max(4),
    requestTimeoutMs: z.number().int().min(1000).max(30000),
    stopP95Ms: z.number().int().min(100).max(30000),
    stopServerErrorRate: z.number().min(0).max(0.05),
  })
  .strict()
  .superRefine((p, c) => {
    const url = new URL(p.origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      c.addIssue({
        code: "custom",
        message: "load_origin_must_be_a_bare_origin",
      });
    if (p.mode === "emulator") {
      if (
        !p.project.startsWith("demo-") ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1"
      )
        c.addIssue({
          code: "custom",
          message: "emulator_requires_demo_project_and_loopback",
        });
    } else {
      if (
        p.project !== "project-b6fe4904-e687-4365-b2f" ||
        url.origin !==
          "https://project-b6fe4904-e687-4365-b2f.firebaseapp.com" ||
        p.profiles.some(
          (x) => ![1, 4, 8].includes(x.virtualUsers) || x.requests > 60,
        ) ||
        p.profiles.reduce((n, x) => n + x.requests, 0) > 180 ||
        p.stopP95Ms > 10000
      )
        c.addIssue({
          code: "custom",
          message: "cloud_read_plan_exceeds_authorized_scope",
        });
    }
  });
export type LoadPlan = z.infer<typeof LoadPlanSchema>;

export function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  if (quantile < 0 || quantile > 1) throw Error("invalid_quantile");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

export type Sample = {
  requestId?: string;
  serverRequestId?: string;
  traceId?: string;
  phase?: "headers" | "body" | "json" | "invariant" | "complete";
  headersMs?: number;
  label: string;
  milliseconds: number;
  status: number;
  expected: boolean;
  bytes: number;
  error?:
    "request_timeout" | "network_error" | "invalid_json" | "invariant_failed";
};
export class LoadMetrics {
  samples: Sample[] = [];
  stopReason: string | null = null;
  constructor(
    private plan: Pick<LoadPlan, "stopP95Ms" | "stopServerErrorRate">,
  ) {}
  record(sample: Sample) {
    this.samples.push(sample);
    if (sample.error === "invariant_failed")
      this.stopReason ||= "invariant_failed";
    const recent = this.samples.slice(-100);
    if (recent.length >= 10) {
      const errors = recent.filter(
        (x) => x.status >= 500 || x.status === 0,
      ).length;
      if (errors / recent.length > this.plan.stopServerErrorRate)
        this.stopReason ||= "server_or_transport_error_rate_exceeded";
      if (
        percentile(
          recent.map((x) => x.milliseconds),
          0.95,
        ) > this.plan.stopP95Ms
      )
        this.stopReason ||= "p95_latency_exceeded";
    }
  }
  summary() {
    const summarize = (rows: Sample[]) => ({
      requests: rows.length,
      p50Ms: round(
        percentile(
          rows.map((x) => x.milliseconds),
          0.5,
        ),
      ),
      p95Ms: round(
        percentile(
          rows.map((x) => x.milliseconds),
          0.95,
        ),
      ),
      p99Ms: round(
        percentile(
          rows.map((x) => x.milliseconds),
          0.99,
        ),
      ),
      maximumMs: round(Math.max(0, ...rows.map((x) => x.milliseconds))),
      unexpectedResponses: rows.filter((x) => !x.expected).length,
      serverErrors: rows.filter((x) => x.status >= 500).length,
      transportErrors: rows.filter((x) => x.status === 0 || x.error === "network_error" || x.error === "request_timeout").length,
      invariantFailures: rows.filter((x) => x.error === "invariant_failed")
        .length,
      expectedRejections: rows.filter((x) => x.expected && x.status >= 400)
        .length,
      responseBytes: rows.reduce((n, x) => n + x.bytes, 0),
      statusCounts: Object.fromEntries(
        [...new Set(rows.map((x) => x.status))]
          .sort()
          .map((s) => [s, rows.filter((x) => x.status === s).length]),
      ),
    });
    return {
      ...summarize(this.samples),
      failures: this.samples.filter((row) => !row.expected).map((row) => ({ ...row })),
      stopReason: this.stopReason,
      byOperation: Object.fromEntries(
        [...new Set(this.samples.map((x) => x.label))]
          .sort()
          .map((label) => [
            label,
            summarize(this.samples.filter((x) => x.label === label)),
          ]),
      ),
    };
  }
}
const round = (n: number) => Math.round(n * 100) / 100;

/** A closed loop, not a fire-and-forget request storm. In-flight requests drain on stop. */
export async function runVirtualUsers(
  virtualUsers: number,
  requestCap: number,
  stopped: () => boolean,
  step: (virtualUser: number, iteration: number) => Promise<void>,
  thinkTimeMs = 0,
) {
  if (
    !Number.isInteger(virtualUsers) ||
    virtualUsers < 1 ||
    virtualUsers > 100 ||
    !Number.isInteger(requestCap) ||
    requestCap < 1
  )
    throw Error("invalid_load_bounds");
  let issued = 0;
  await Promise.all(
    Array.from({ length: virtualUsers }, async (_, user) => {
      let iteration = 0;
      const perUserCap =
        Math.floor(requestCap / virtualUsers) +
        (user < requestCap % virtualUsers ? 1 : 0);
      while (!stopped() && iteration < perUserCap) {
        issued++;
        await step(user, iteration++);
        if (thinkTimeMs)
          await new Promise((resolve) => setTimeout(resolve, thinkTimeMs));
      }
    }),
  );
  return issued;
}

export async function measuredRequest(
  metrics: LoadMetrics,
  origin: string,
  options: {
    label: string;
    path: string;
    token?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    expected?: number[];
    timeoutMs: number;
    idempotencyKey?: string;
    invariant?: (value: any) => boolean;
  },
) {
  const started = performance.now();
  const requestId = randomUUID();
  const traceId = requestId.replaceAll("-", "");
  let serverRequestId: string | undefined;
  let phase: Sample["phase"] = "headers";
  let headersMs: number | undefined;
  let status = 0,
    bytes = 0,
    expected = false;
  let error: Sample["error"];
  let data: any = null;
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await fetch(origin + "/api/v1" + options.path, {
      method: options.method || "GET",
      headers: {
        ...(options.token ? { authorization: "Bearer " + options.token } : {}),
        "content-type": "application/json",
        "X-Client-Request-Id": requestId,
        "X-Cloud-Trace-Context": traceId + "/1;o=1",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "error",
    });
    status = response.status;
    headersMs = performance.now() - started;
    serverRequestId = response.headers.get("X-Request-Id") || undefined;
    phase = "body";
    const text = await response.text();
    bytes = Buffer.byteLength(text);
    try {
      phase = "json";
      data = JSON.parse(text);
    } catch {
      error = "invalid_json";
    }
    expected = (options.expected || [200]).includes(status) && !error;
    if (expected && options.invariant) {
      phase = "invariant";
      let valid = false;
      try {
        valid = options.invariant(data);
      } catch {
        /* Malformed output is a failed invariant. */
      }
      if (!valid) {
        expected = false;
        error = "invariant_failed";
      }
    }
    if (expected) phase = "complete";
  } catch (e) {
    expected = false;
    error =
      (e as Error).name === "TimeoutError" || (signal.aborted && signal.reason?.name === "TimeoutError")
        ? "request_timeout"
        : "network_error";
  }
  metrics.record({
    label: options.label,
    milliseconds: performance.now() - started,
    status,
    expected,
    bytes,
    requestId, traceId, phase,
    ...(serverRequestId ? { serverRequestId } : {}),
    ...(headersMs === undefined ? {} : { headersMs }),
    ...(error ? { error } : {}),
  });
  return { status, data, expected };
}
