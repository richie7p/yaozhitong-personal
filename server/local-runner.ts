import { uptime } from "node:os";

// Approximate boot time prevents a reused PID after a computer reboot from
// keeping a dead worker's lease. Allow clock/uptime rounding differences.
export const localWorkerBootTime = Date.now() - uptime() * 1000;
/** Local jobs use a bounded queue; persisted jobs are recovered by the scheduler. */
export function localWorkerAlive(pid: number, bootTime?: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (
    Number.isFinite(bootTime) &&
    Math.abs(localWorkerBootTime - bootTime!) > 60000
  )
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // Permission failures do not prove that another local worker has stopped.
    return error.code !== "ESRCH";
  }
}

export class LocalRunner {
  private pending = new Set<string>();
  private running = new Set<string>();
  private stopped = false;
  constructor(
    private process: (id: string) => Promise<void>,
    private concurrency = 2,
    private onError = () => console.error("local_job_failed"),
  ) {}
  enqueue = async (id: string) => {
    if (this.stopped || this.running.has(id)) return;
    this.pending.add(id);
    this.drain();
  };
  stop() {
    this.stopped = true;
  }
  private drain() {
    while (
      !this.stopped &&
      this.running.size < this.concurrency &&
      this.pending.size
    ) {
      const id = this.pending.values().next().value!;
      this.pending.delete(id);
      this.running.add(id);
      Promise.resolve()
        .then(() => this.process(id))
        .catch(this.onError)
        .finally(() => {
          this.running.delete(id);
          this.drain();
        });
    }
  }
}
