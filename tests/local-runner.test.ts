import { it, expect, vi } from "vitest";
import { LocalRunner } from "../server/local-runner";

it("bounds concurrent local jobs, deduplicates IDs and continues after failure", async () => {
  const release: Record<string, () => void> = {};
  const starts: string[] = [];
  const errors = vi.fn();
  const runner = new LocalRunner(
    async (id) => {
      starts.push(id);
      await new Promise<void>((r) => {
        release[id] = r;
      });
      if (id === "a") throw Error("fixture failure");
    },
    2,
    errors,
  );
  await Promise.all(["a", "b", "c", "c", "a"].map(runner.enqueue));
  expect(starts).toEqual(["a", "b"]);
  release.a();
  await vi.waitFor(() => expect(starts).toEqual(["a", "b", "c"]));
  expect(errors).toHaveBeenCalledTimes(1);
  release.b();
  release.c();
  runner.stop();
  await runner.enqueue("d");
  expect(starts).not.toContain("d");
});
