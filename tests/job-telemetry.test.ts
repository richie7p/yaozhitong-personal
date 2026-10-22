import { expect, it, vi } from "vitest";
import { jobFailureEvent } from "../server/job-telemetry";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import { AppError } from "../server/config";
it("emits allowlisted operational fields without owner, question or provider message", () => {
  const row = {
    id: hash("synthetic job"),
    kind: "chat" as const,
    attempts: 1,
    ownerId: "private-owner",
    input: { question: "private-question" },
    message: "private-token",
  };
  expect(jobFailureEvent(row, "ai_timeout")).toEqual({
    severity: "ERROR",
    event: "job_failed",
    status: 500,
    kind: "chat",
    attempt: 1,
    code: "ai_timeout",
    jobId: row.id,
  });
  expect(
    jobFailureEvent(
      { ...row, id: "private-owner" },
      "unsafe message with health content",
    ),
  ).toEqual({
    severity: "ERROR",
    event: "job_failed",
    status: 500,
    kind: "chat",
    attempt: 1,
    code: "generation_failed",
  });
});
it("keeps expected client failures distinguishable from infrastructure errors", () => {
  const job = {
    id: hash("synthetic client failure"),
    kind: "chat" as const,
    attempts: 1,
  };
  expect(jobFailureEvent(job, "identity_changed", 409)).toMatchObject({
    status: 409,
  });
  expect(jobFailureEvent(job, "invalid_ai_output", 502)).toMatchObject({
    status: 502,
  });
  expect(jobFailureEvent(job, "generation_failed", Number.NaN)).toMatchObject({
    status: 500,
  });
});
it("logs a persisted failed attempt once, without raw error or source input", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const blobs = {
      get: async () => Buffer.from("synthetic photo"),
      delete: async () => {},
    };
    const domain = new Domain(store, blobs as any, () => ({
      json: async () => {
        throw new AppError(
          "ai_timeout",
          "private upstream credential and health message",
          503,
        );
      },
    }));
    await domain.account({
      uid: "telemetry-owner",
      email: "telemetry@example.test",
      name: "Synthetic",
      admin: false,
      verified: true,
    });
    const job = await domain.enqueueJob(
      "telemetry-owner",
      true,
      "recognition",
      { imagePath: "synthetic-private-photo", imageHash: "synthetic" },
      "synthetic-telemetry-001",
    );
    await domain.processJob(job.id);
    expect((await store.get("jobs", job.id))?.status).toBe("failed");
    expect(spy).toHaveBeenCalledOnce();
    const event = JSON.parse(spy.mock.calls[0][0]);
    expect(event).toMatchObject({
      event: "job_failed",
      code: "ai_timeout",
      status: 503,
      attempt: 1,
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private|credential|photo|telemetry-owner|upstream/,
    );
    await domain.processJob(job.id);
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
  }
});
