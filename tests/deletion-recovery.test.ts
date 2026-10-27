import { afterEach, describe, expect, it, vi } from "vitest";
import { Domain, hash } from "../server/domain";
import { config } from "../server/config";
import { createApp } from "../server/app";
import { CloudJobQueue } from "../server/job-queue";
import { tick } from "../server/scheduler";
import { MemoryStore, type Tx } from "../server/store";

const mode = config.mode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  config.mode = mode;
});

async function fixture() {
  config.mode = "local";
  const store = new MemoryStore();
  let failures = 0;
  const remove = vi.fn(async (_path: string) => {
    if (failures > 0) {
      failures--;
      throw new Error("synthetic transient blob deletion failure");
    }
  });
  const domain = new Domain(store, { delete: remove } as any, () => {
    throw new Error("Deletion tests must not call an AI provider");
  });
  for (const uid of ["owner", "caregiver", "admin"])
    await domain.account({
      uid,
      email: uid + "@example.invalid",
      name: uid,
      verified: true,
      admin: uid === "admin",
    });
  const relationship = {
    id: hash("owner|caregiver"),
    ownerId: "owner",
    caregiverId: "caregiver",
    active: true,
    createdAt: new Date().toISOString(),
  };
  await store.set("relationships", relationship.id, relationship);
  const id = "delete-" + hash("owner");
  return {
    store,
    domain,
    id,
    relationship,
    remove,
    failDeletes: (count: number) => {
      failures = count;
    },
  };
}

function pauseNextTransaction(store: MemoryStore) {
  const original = store.transaction.bind(store);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  store.transaction = async <T>(operation: (tx: Tx) => Promise<T>) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return original(operation);
  };
  return { started, release };
}

async function seedPhoto(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.set("jobs", "synthetic-photo", {
    id: "synthetic-photo",
    ownerId: "owner",
    kind: "recognition",
    status: "succeeded",
    input: { imagePath: "synthetic/photo.png" },
    result: null,
    error: null,
    attempts: 1,
    leaseUntil: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("account deletion survives storage failures and competing cleanup", () => {
  it("keeps a failed cleanup retryable, respects backoff in worker/queue/tick, then completes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const f = await fixture();
    await seedPhoto(f);
    f.failDeletes(1);
    await f.domain.deleteAccount("owner");
    await f.domain.processJob(f.id);
    const waiting = await f.store.get("jobs", f.id);
    expect(waiting).toMatchObject({ status: "queued", attempts: 1 });
    expect(waiting!.leaseUntil).toBeGreaterThan(Date.now());
    await f.domain.processJob(f.id);
    expect((await f.store.get("jobs", f.id))!.attempts).toBe(1);
    const create = vi.fn(async () => {});
    const queue = new CloudJobQueue(f.store, {
      create,
      exists: async () => false,
    });
    await queue.enqueue(f.id);
    expect(create).not.toHaveBeenCalled();
    const enqueued: string[] = [];
    f.domain.enqueue = async (id) => {
      enqueued.push(id);
    };
    await tick(f.domain);
    expect(enqueued).toEqual([]);
    vi.setSystemTime(waiting!.leaseUntil + 1);
    await tick(f.domain);
    expect(enqueued).toEqual([f.id]);
    await queue.enqueue(f.id);
    expect(create).toHaveBeenCalledTimes(1);
    await f.domain.processJob(f.id);
    expect(await f.store.get("jobs", f.id)).toBeNull();
    expect(await f.store.list("relationships")).toEqual([]);
    expect(await f.store.get("users", "owner")).toHaveProperty("deletedAt");
  });

  it("recovers after more than three transient failures without a tight retry loop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const f = await fixture();
    await seedPhoto(f);
    f.failDeletes(4);
    await f.domain.deleteAccount("owner");
    for (let attempt = 1; attempt <= 4; attempt++) {
      await f.domain.processJob(f.id);
      const waiting = await f.store.get("jobs", f.id);
      expect(waiting).toMatchObject({ status: "queued", attempts: attempt });
      expect(waiting!.leaseUntil).toBeGreaterThan(Date.now());
      expect(waiting!.leaseUntil - Date.now()).toBeLessThanOrEqual(300000);
      vi.setSystemTime(waiting!.leaseUntil + 1);
    }
    await f.domain.processJob(f.id);
    expect(await f.store.get("jobs", f.id)).toBeNull();
    expect(await f.store.get("users", "owner")).toHaveProperty("deletedAt");
  });

  it("lets an administrator resume a legacy failed deletion after the normal retry limit", async () => {
    const f = await fixture();
    await f.domain.deleteAccount("owner");
    const job = await f.store.get("jobs", f.id);
    await f.store.set("jobs", f.id, {
      ...job,
      status: "failed",
      attempts: 3,
      leaseUntil: 0,
    });
    const app = createApp(f.domain, async () => ({
      uid: "admin",
      email: "admin@example.invalid",
      name: "admin",
      verified: true,
      admin: true,
    }));
    const response = await app.request(`/api/v1/admin/jobs/${f.id}/retry`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-admin" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ jobId: f.id });
    expect(await f.store.get("jobs", f.id)).toMatchObject({
      status: "queued",
      attempts: 3,
      leaseUntil: 0,
    });
    await f.domain.processJob(f.id);
    expect(await f.store.get("jobs", f.id)).toBeNull();
  });

  it("retains the three-attempt cap for ordinary AI jobs", async () => {
    const f = await fixture();
    await f.store.set("jobs", "ordinary", {
      id: "ordinary",
      ownerId: "owner",
      kind: "bundle",
      status: "failed",
      input: {},
      attempts: 3,
      leaseUntil: 0,
    });
    await expect(f.domain.retryJob("owner", "ordinary")).rejects.toMatchObject({
      code: "retry_limit",
    });
  });

  it("does not recreate a finished deletion job when an expired worker fails late", async () => {
    const f = await fixture();
    await f.domain.deleteAccount("owner");
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.domain, "cleanupUser").mockImplementationOnce(async () => {
      entered();
      await gate;
      throw new Error("late failed old attempt");
    });
    const oldAttempt = f.domain.processJob(f.id);
    await started;
    const job = await f.store.get("jobs", f.id);
    await f.store.set("jobs", f.id, { ...job, leaseUntil: 0 });
    await f.domain.processJob(f.id);
    expect(await f.store.get("jobs", f.id)).toBeNull();
    release();
    await oldAttempt;
    expect(await f.store.get("jobs", f.id)).toBeNull();
  });

  it("does not resurrect relationships when account deletion finishes during its deactivation list", async () => {
    const f = await fixture();
    const original = f.domain.relationships.bind(f.domain);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.domain, "relationships").mockImplementationOnce(async (uid) => {
      const rows = await original(uid);
      entered();
      await gate;
      return rows;
    });
    const deletion = f.domain.deleteAccount("owner");
    await started;
    await f.domain.processJob(f.id);
    release();
    await deletion;
    expect(await f.store.list("relationships")).toEqual([]);
  });

  it("does not resurrect a relationship from a revoke request paused before its write", async () => {
    const f = await fixture();
    const pause = pauseNextTransaction(f.store);
    const revoke = f.domain.revoke("owner", f.relationship.id).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    await pause.started;
    await f.domain.deleteAccount("owner");
    await f.domain.processJob(f.id);
    pause.release();
    expect(await revoke).toEqual({ ok: false });
    expect(await f.store.list("relationships")).toEqual([]);
  });
});
