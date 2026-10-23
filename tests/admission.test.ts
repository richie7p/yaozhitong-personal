import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionGate } from "../server/admission";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
afterEach(() => vi.useRealTimers());
describe("bounded quota transaction admission", () => {
  it("limits active work and serves the waiting operations in order", async () => {
    const gate = new AdmissionGate(2, 10, 1000),
      release = deferred();
    let active = 0,
      peak = 0;
    const order: number[] = [];
    const calls = Array.from({ length: 8 }, (_, i) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        if (i < 2) await release.promise;
        active--;
        return i;
      }),
    );
    await vi.waitFor(() => expect(order).toEqual([0, 1]));
    release.resolve();
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("rejects overflow before invoking an operation and later accepts work", async () => {
    const gate = new AdmissionGate(1, 1, 1000),
      release = deferred();
    const first = gate.run(() => release.promise);
    const second = gate.run(async () => 2);
    const extra = vi.fn(async () => 3);
    await expect(gate.run(extra)).rejects.toMatchObject({
      code: "service_busy",
      status: 503,
    });
    expect(extra).not.toHaveBeenCalled();
    release.resolve();
    await first;
    expect(await second).toBe(2);
    expect(await gate.run(extra)).toBe(3);
  });
  it("never executes an operation whose wait timed out", async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate(1, 2, 100),
      release = deferred();
    const first = gate.run(() => release.promise);
    const stale = vi.fn(async () => 2);
    const pending = gate.run(stale);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "service_busy",
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    release.resolve();
    await first;
    expect(await gate.run(async () => 3)).toBe(3);
    expect(stale).not.toHaveBeenCalled();
  });
  it("releases its slot after an operation fails", async () => {
    const gate = new AdmissionGate(1, 2, 1000);
    const first = gate.run(async () => {
      throw Error("synthetic transaction failure");
    });
    const next = gate.run(async () => 42);
    await expect(first).rejects.toThrow("synthetic");
    expect(await next).toBe(42);
  });
});
