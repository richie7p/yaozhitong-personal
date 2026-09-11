/** Local jobs use a bounded queue; persisted jobs are recovered by the scheduler. */
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
