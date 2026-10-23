import { AppError } from "./config.js";
const busy = () =>
  new AppError("service_busy", "目前使用人數較多，請稍候以原操作重試。", 503);
/** Bound contention on exact quota counters; waiting never reserves quota. */
export class AdmissionGate {
  private active = 0;
  private waiters: {
    grant: () => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  constructor(
    private concurrency = 2,
    private maxWaiting = 128,
    private timeoutMs = 20000,
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isSafeInteger(maxWaiting) ||
      maxWaiting < 0 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    )
      throw Error("invalid_admission_limits");
  }
  private async enter() {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    if (this.waiters.length >= this.maxWaiting) throw busy();
    await new Promise<void>((resolve, reject) => {
      const entry = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) {
            this.waiters.splice(index, 1);
            reject(busy());
          }
        }, this.timeoutMs),
      };
      this.waiters.push(entry);
    });
  }
  private leave() {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else this.active--;
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.enter();
    try {
      return await operation();
    } finally {
      this.leave();
    }
  }
}
