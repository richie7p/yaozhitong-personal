export const PENDING_JOB_STORAGE_KEY = "yzt-pending-ai-v1";
const MAX_PENDING_JOBS = 32;

export interface PendingJob {
  ownerHash: string;
  fingerprint: string;
  key: string;
  jobId?: string;
  createdAt: number;
}

export async function jobFingerprint(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

// Only hashes and operation identifiers reach storage. Never retain request bodies.
export class PendingJobs {
  private records = new Map<string, PendingJob>();
  private ownerHash: string | null = null;
  private storageAvailable = true;

  clear() {
    this.records.clear();
    this.ownerHash = null;
    try {
      sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
    } catch {
      this.storageAvailable = false;
    }
  }

  private load(ownerHash: string) {
    if (this.ownerHash === ownerHash) return;
    this.records.clear();
    this.ownerHash = ownerHash;
    if (!this.storageAvailable) return;
    try {
      const raw = sessionStorage.getItem(PENDING_JOB_STORAGE_KEY);
      const rows: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(rows) || rows.length > MAX_PENDING_JOBS) return;
      for (const value of rows) {
        if (
          value?.ownerHash === ownerHash &&
          /^[a-f0-9]{64}$/.test(value.fingerprint) &&
          /^[a-zA-Z0-9-]{8,100}$/.test(value.key) &&
          (value.jobId === undefined ||
            /^[a-zA-Z0-9_-]{1,100}$/.test(value.jobId)) &&
          Number.isFinite(value.createdAt)
        ) {
          this.records.set(value.fingerprint, {
            ownerHash,
            fingerprint: value.fingerprint,
            key: value.key,
            ...(value.jobId ? { jobId: value.jobId } : {}),
            createdAt: value.createdAt,
          });
        }
      }
    } catch {
      this.storageAvailable = false;
    }
  }

  private save() {
    if (!this.storageAvailable) return;
    try {
      if (this.records.size)
        sessionStorage.setItem(
          PENDING_JOB_STORAGE_KEY,
          JSON.stringify([...this.records.values()]),
        );
      else sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
    } catch {
      this.storageAvailable = false;
    }
  }

  get(ownerHash: string, fingerprint: string): PendingJob | undefined {
    this.load(ownerHash);
    return this.records.get(fingerprint);
  }

  create(ownerHash: string, fingerprint: string): PendingJob | null {
    this.load(ownerHash);
    // Refuse overflow instead of evicting an unresolved operation and duplicating it.
    if (this.records.size >= MAX_PENDING_JOBS) return null;
    const record = {
      ownerHash,
      fingerprint,
      key: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.records.set(fingerprint, record);
    this.save();
    return record;
  }

  rememberJob(record: PendingJob, jobId: string) {
    if (this.records.get(record.fingerprint) !== record) return;
    record.jobId = jobId;
    this.save();
  }

  complete(record: PendingJob) {
    if (this.records.get(record.fingerprint) !== record) return;
    this.records.delete(record.fingerprint);
    this.save();
  }
}
