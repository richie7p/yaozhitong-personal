import { expect, it, vi } from "vitest";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { tick } from "../server/scheduler";
import { localWorkerAlive, localWorkerBootTime } from "../server/local-runner";

async function setup(json = async () => ({ status: "not_found", claims: [] })) {
  const store = new MemoryStore();
  const d = new Domain(store, undefined, () => ({ json }));
  await d.account({
    uid: "recovery",
    email: "test@example.invalid",
    name: "合成恢復測試",
    verified: true,
    admin: false,
  });
  const med = await d.saveMedication("recovery", {
    name: "合成恢復測試片",
    doseAmount: 1,
    doseUnit: "錠",
    frequencyRaw: "QD",
    confirmed: true,
  });
  const job = await d.enqueueJob(
    "recovery",
    true,
    "bundle",
    { medicationIds: [med.id] },
    crypto.randomUUID(),
  );
  return { store, d, med, job };
}

it("recovers a dead local worker immediately but never steals a live or unidentified lease", async () => {
  const { store, d, job } = await setup();
  const deadPid = 2147483000;
  const originalKill = process.kill.bind(process);
  const probe = vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal: number,
  ) => {
    if (pid === deadPid)
      throw Object.assign(Error("dead fixture"), { code: "ESRCH" });
    return originalKill(pid, signal);
  }) as typeof process.kill);
  try {
    const leaseUntil = Date.now() + 540000;
    for (const [id, owner] of [
      ["dead", { localWorkerPid: deadPid, localWorkerBootTime }],
      ["live", { localWorkerPid: process.pid, localWorkerBootTime }],
      ["legacy", {}],
      [
        "previous-boot",
        {
          localWorkerPid: process.pid,
          localWorkerBootTime: localWorkerBootTime - 3600000,
        },
      ],
    ] as const)
      await store.set("jobs", id, {
        ...job,
        id,
        status: "running",
        attempts: 1,
        leaseUntil,
        ...owner,
      });
    await store.delete("jobs", job.id);
    const enqueued: string[] = [];
    d.enqueue = async (id) => {
      enqueued.push(id);
    };
    await tick(d);
    expect(enqueued.sort()).toEqual(["dead", "previous-boot"]);
    expect((await store.get("jobs", "live"))?.leaseUntil).toBe(leaseUntil);
    expect((await store.get("jobs", "legacy"))?.leaseUntil).toBe(leaseUntil);
    expect((await store.get("jobs", "dead"))?.attempts).toBe(1);
  } finally {
    probe.mockRestore();
  }
});

it("treats an inaccessible PID as possibly alive", () => {
  const probe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("access denied"), { code: "EPERM" });
  });
  try {
    expect(localWorkerAlive(123, localWorkerBootTime)).toBe(true);
  } finally {
    probe.mockRestore();
  }
});

it("does not let an earlier attempt overwrite the recovered job result", async () => {
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const { d, store, med, job } = await setup(async () => {
    calls++;
    if (calls === 1) {
      entered();
      await blocked;
      return { status: "not_found", claims: [] };
    }
    return { status: "insufficient_data", claims: [] };
  });
  const licenseNo = "SYNTHETIC-RECOVERY";
  await store.set("medications", med.id, { ...med, licenseNo });
  await store.set("published", hash(licenseNo), { leafletId: "fixture" });
  await store.set("leaflets", "fixture", {
    licenseNo,
    status: "published",
    version: "v1",
    sha256: "fixture",
    chunks: [
      {
        id: "fixture-1",
        licenseNo,
        version: "v1",
        page: 1,
        start: 0,
        text: "本文件完全為合成資料，僅供軟體流程測試。",
      },
    ],
  });
  d.catalog.get = async () => null;
  const old = d.processJob(job.id);
  await reached;
  const claimed = (await store.get("jobs", job.id))!;
  expect(claimed).toMatchObject({
    localWorkerPid: process.pid,
    localWorkerBootTime,
  });
  await store.set("jobs", job.id, { ...claimed, leaseUntil: 0 });
  await d.processJob(job.id);
  const recovered = await store.get("jobs", job.id);
  expect(recovered).toMatchObject({
    attempts: 2,
    status: "succeeded",
    result: { status: "insufficient_data" },
  });
  release();
  await old;
  expect(await store.get("jobs", job.id)).toEqual(recovered);
  expect(await store.list("learning")).toHaveLength(1);
  expect(await store.list("generated")).toHaveLength(1);
});

it("clears the uploaded photo when repeated crashes exhaust recognition recovery", async () => {
  const { store, d, job } = await setup();
  const remove = vi.spyOn(d.blobs, "delete").mockResolvedValue();
  await store.set("jobs", job.id, {
    ...job,
    kind: "recognition",
    status: "running",
    attempts: 3,
    leaseUntil: 0,
    input: { imagePath: "uploads/synthetic-recovery", mediaType: "image/png" },
  });
  await d.processJob(job.id);
  expect(await store.get("jobs", job.id)).toMatchObject({
    status: "failed",
    input: {},
    error: { code: "retry_limit" },
  });
  expect((await store.get("jobs", job.id))?.input).toEqual({});
  expect(remove).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("uploads/synthetic-recovery");
});

it.each(["success", "failure"])(
  "does not let an expired recognition attempt delete a newer worker's photo after its late %s",
  async (oldOutcome) => {
    const { store, d, job } = await setup();
    let releaseOld!: () => void, oldEntered!: () => void;
    let releaseNew!: () => void, newEntered!: () => void;
    const oldBlocked = new Promise<void>((r) => {
      releaseOld = r;
    });
    const firstEntered = new Promise<void>((r) => {
      oldEntered = r;
    });
    const newBlocked = new Promise<void>((r) => {
      releaseNew = r;
    });
    const recoveryEntered = new Promise<void>((r) => {
      newEntered = r;
    });
    let calls = 0;
    d.llmFactory = () => ({
      json: async () => {
        if (++calls === 1) {
          oldEntered();
          await oldBlocked;
          if (oldOutcome === "failure") throw Error("Synthetic late failure");
        }
        return { status: "succeeded", medications: [] };
      },
    });
    let deleted = false;
    const photo = Buffer.from("Synthetic photo; no real patient data");
    vi.spyOn(d.blobs, "get").mockImplementation(async () => {
      if (deleted) throw Error("Synthetic photo was prematurely deleted");
      return photo;
    });
    const remove = vi.spyOn(d.blobs, "delete").mockImplementation(async () => {
      deleted = true;
    });
    const active = d.active.bind(d);
    let activeCalls = 0;
    vi.spyOn(d, "active").mockImplementation(async (uid) => {
      // Pause the new worker after it owns the lease, before downloading.
      if (++activeCalls === 2) {
        newEntered();
        await newBlocked;
      }
      return active(uid);
    });
    await store.set("jobs", job.id, {
      ...job,
      kind: "recognition",
      input: {
        imagePath: "uploads/synthetic-recovery-race",
        mediaType: "image/png",
      },
    });
    const old = d.processJob(job.id);
    await firstEntered;
    const claimed = (await store.get("jobs", job.id))!;
    await store.set("jobs", job.id, { ...claimed, leaseUntil: 0 });
    const recovered = d.processJob(job.id);
    try {
      await recoveryEntered;
      releaseOld();
      await old;
      expect(await store.get("jobs", job.id)).toMatchObject({
        status: "running",
        attempts: 2,
      });
      expect(remove).not.toHaveBeenCalled();
      releaseNew();
      await recovered;
      expect(await store.get("jobs", job.id)).toMatchObject({
        status: "succeeded",
        attempts: 2,
        input: {},
      });
      expect(remove).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("uploads/synthetic-recovery-race");
    } finally {
      releaseOld();
      releaseNew();
      await Promise.all([old, recovered]);
    }
  },
);
