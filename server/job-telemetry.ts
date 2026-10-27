import type { Job } from "../shared/schema.js";
/** Operational failure metadata only. Never log prompts, source text or user data. */
export function jobFailureEvent(
  job: Pick<Job, "id" | "kind" | "attempts">,
  code: string,
  status = 500,
) {
  return {
    severity: "ERROR",
    event: "job_failed",
    status:
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    kind: job.kind,
    code: /^[a-z_]{1,60}$/.test(code) ? code : "generation_failed",
    attempt: Number.isInteger(job.attempts) ? job.attempts : 0,
    ...(/^(delete-)?[a-f0-9]{64}$/.test(job.id) ? { jobId: job.id } : {}),
  };
}
