import { createHash } from "node:crypto";
import { AppError } from "./config.js";
import type { Job } from "../shared/schema.js";
import type { Store } from "./store.js";

export interface TaskTransport {
  create(taskId: string, jobId: string): Promise<void>;
  exists(taskId: string): Promise<boolean>;
}
type DispatchedJob = Job & { dispatchGeneration?: number };
const unavailable = () =>
  new AppError(
    "queue_unavailable",
    "背景服務暫時無法排入，請以原操作重試。",
    503,
  );
const eligible = (job: DispatchedJob | null) =>
  !!job &&
  (job.status === "queued" ||
    (job.status === "running" && job.leaseUntil <= Date.now()));
function counters(job: DispatchedJob) {
  const generation = job.dispatchGeneration ?? 0;
  if (
    ![job.attempts, generation].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    generation === Number.MAX_SAFE_INTEGER
  )
    throw unavailable();
  return { attempts: job.attempts, generation };
}
export function dispatchTaskId(
  jobId: string,
  attempts: number,
  generation: number,
) {
  return (
    "yzt-" +
    createHash("sha256")
      .update(JSON.stringify([jobId, attempts, generation]))
      .digest("hex")
  );
}

/** Cloud Tasks deduplicates across instances. A missing tombstoned task gets a
 * new generation only after a transaction rechecks the current job state. */
export class CloudJobQueue {
  private flights = new Map<string, Promise<void>>();
  constructor(
    private store: Store,
    private transport: TaskTransport,
  ) {}
  enqueue(id: string): Promise<void> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    const promise = this.dispatch(id);
    this.flights.set(id, promise);
    const done = () => {
      if (this.flights.get(id) === promise) this.flights.delete(id);
    };
    void promise.then(done, done);
    return promise;
  }
  private async dispatch(id: string) {
    try {
      for (let round = 0; round < 3; round++) {
        const job = await this.store.get<DispatchedJob>("jobs", id);
        if (!eligible(job)) return;
        const expected = counters(job!);
        const taskId = dispatchTaskId(
          id,
          expected.attempts,
          expected.generation,
        );
        try {
          await this.transport.create(taskId, id);
          return;
        } catch (error) {
          if ((error as { code?: number }).code !== 6) throw unavailable();
        }
        // ALREADY_EXISTS also covers completed-task tombstones. Never mistake
        // a network/permission failure for absence, or advance after ambiguity.
        if (await this.transport.exists(taskId)) return;
        const state = await this.store.transaction(async (tx) => {
          const current = await tx.get<DispatchedJob>("jobs", id);
          if (!eligible(current)) return "inactive";
          const actual = counters(current!);
          if (
            actual.attempts !== expected.attempts ||
            actual.generation !== expected.generation
          )
            return "changed";
          tx.set("jobs", id, {
            ...current,
            dispatchGeneration: actual.generation + 1,
          });
          return "advanced";
        });
        if (state === "inactive") return;
      }
      throw unavailable();
    } catch {
      throw unavailable();
    }
  }
}
