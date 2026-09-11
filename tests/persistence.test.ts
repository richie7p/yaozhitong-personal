import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { MemoryStore } from "../server/store";
it("preserves 120 updates from four independent processes and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yzt-store-test-"));
  const file = join(dir, "db.json");
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "tests/support/store-worker.ts", file, "30"],
            { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0
              ? resolve()
              : reject(Error("Store child failed: " + code + " " + stderr)),
          );
        }),
    ),
  );
  expect((await new MemoryStore(file).load()).data.counters.shared.value).toBe(
    120,
  );
  expect(JSON.parse(await readFile(file, "utf8")).counters.shared.value).toBe(
    120,
  );
}, 30000);
it("does not overwrite a damaged database with a blank store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yzt-store-test-"));
  const file = join(dir, "db.json");
  await writeFile(file, "{damaged");
  await expect(
    new MemoryStore(file).set("counters", "x", {}),
  ).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("{damaged");
});
