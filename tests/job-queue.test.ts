import { describe, expect, it, vi } from "vitest";
import {
  CloudJobQueue,
  dispatchTaskId,
  type TaskTransport,
} from "../server/job-queue";
import { MemoryStore } from "../server/store";

function fixture() {
  const store = new MemoryStore();
  const job = {
    id: "synthetic-queue-job",
    ownerId: "synthetic-owner",
    kind: "bundle",
    status: "queued",
    input: {},
    result: null,
    error: null,
    attempts: 0,
    leaseUntil: 0,
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
  };
  store.data.jobs = { [job.id]: structuredClone(job) };
  const live = new Set<string>(),
    tombstones = new Set<string>();
  const transport: TaskTransport = {
    create: vi.fn(async (taskId) => {
      if (live.has(taskId) || tombstones.has(taskId))
        throw Object.assign(new Error("already_exists"), { code: 6 });
      live.add(taskId);
    }),
    exists: vi.fn(async (taskId) => live.has(taskId)),
  };
  const queue = () => new CloudJobQueue(store, transport);
  return { store, job, live, tombstones, transport, queue };
}

describe("persistent Cloud Tasks identity and retry recovery", () => {
  it("100 callers across two web instances create one live task and coalesce each instance's request", async () => {
    const f = fixture(),
      a = f.queue(),
      b = f.queue();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).enqueue(f.job.id)),
    );
    expect(f.live.size).toBe(1);
    expect(f.transport.create).toHaveBeenCalledTimes(2);
    expect(f.store.data.jobs[f.job.id]).toEqual(f.job);
    expect(f.store.data.usage).toBeUndefined();
  });
  it("recovers a completed-task tombstone with one transactional generation across web instances", async () => {
    const f = fixture();
    f.tombstones.add(dispatchTaskId(f.job.id, 0, 0));
    await Promise.all(
      Array.from({ length: 30 }, () => f.queue().enqueue(f.job.id)),
    );
    expect(f.live).toEqual(new Set([dispatchTaskId(f.job.id, 0, 1)]));
    expect(f.store.data.jobs[f.job.id]).toEqual({
      ...f.job,
      dispatchGeneration: 1,
    });
  });
  it("keeps an ambiguously accepted create on its original identity and safely resumes it", async () => {
    const f = fixture(),
      realCreate = f.transport.create;
    f.transport.create = vi.fn(async (task, id) => {
      await realCreate(task, id);
      throw Object.assign(new Error("sensitive SDK request must not escape"), {
        code: 4,
      });
    });
    const queue = f.queue();
    await expect(queue.enqueue(f.job.id)).rejects.toMatchObject({
      code: "queue_unavailable",
      status: 503,
    });
    f.transport.create = realCreate;
    await queue.enqueue(f.job.id);
    expect(f.live.size).toBe(1);
    expect(f.store.data.jobs[f.job.id].dispatchGeneration).toBeUndefined();
  });
  it.each([7, 14, 4])(
    "does not advance on an ambiguous/denied task lookup (%s)",
    async (code) => {
      const f = fixture();
      f.tombstones.add(dispatchTaskId(f.job.id, 0, 0));
      f.transport.exists = vi.fn(async () => {
        throw Object.assign(new Error("private SDK details"), { code });
      });
      await expect(f.queue().enqueue(f.job.id)).rejects.toMatchObject({
        code: "queue_unavailable",
        status: 503,
      });
      expect(f.store.data.jobs[f.job.id]).toEqual(f.job);
      expect(f.live.size).toBe(0);
    },
  );
  it.each(["succeeded", "failed", "running"])(
    "never dispatches terminal or actively leased %s jobs",
    async (status) => {
      const f = fixture();
      Object.assign(f.store.data.jobs[f.job.id], {
        status,
        leaseUntil: Date.now() + 60000,
      });
      await f.queue().enqueue(f.job.id);
      expect(f.transport.create).not.toHaveBeenCalled();
    },
  );
  it("does not resurrect a job claimed while its task absence was being checked", async () => {
    const f = fixture();
    f.tombstones.add(dispatchTaskId(f.job.id, 0, 0));
    f.transport.exists = vi.fn(async () => {
      Object.assign(f.store.data.jobs[f.job.id], {
        status: "running",
        attempts: 1,
        leaseUntil: Date.now() + 60000,
      });
      return false;
    });
    await f.queue().enqueue(f.job.id);
    expect(f.live.size).toBe(0);
    expect(f.store.data.jobs[f.job.id].dispatchGeneration).toBeUndefined();
  });
  it("uses a new task identity for a normal user retry and for an expired worker", async () => {
    const f = fixture();
    f.tombstones.add(dispatchTaskId(f.job.id, 0, 0));
    Object.assign(f.store.data.jobs[f.job.id], {
      attempts: 1,
      status: "queued",
    });
    await f.queue().enqueue(f.job.id);
    expect(f.live.has(dispatchTaskId(f.job.id, 1, 0))).toBe(true);
    Object.assign(f.store.data.jobs[f.job.id], {
      attempts: 2,
      status: "running",
      leaseUntil: Date.now() - 1,
    });
    await f.queue().enqueue(f.job.id);
    expect(f.live.has(dispatchTaskId(f.job.id, 2, 0))).toBe(true);
  });
  it("fails boundedly if every provider name is already a missing tombstone", async () => {
    const f = fixture();
    f.transport.create = vi.fn(async () => {
      throw Object.assign(new Error(), { code: 6 });
    });
    f.transport.exists = vi.fn(async () => false);
    await expect(f.queue().enqueue(f.job.id)).rejects.toMatchObject({
      code: "queue_unavailable",
      status: 503,
    });
    expect(f.transport.create).toHaveBeenCalledTimes(3);
    expect(f.store.data.jobs[f.job.id].dispatchGeneration).toBe(3);
  });
});
