import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

it("the actual bundled job has one job entry point and does not execute the backup CLI", async () => {
  const requestedCache = path.resolve(".local/recovery-build-tests");
  await fs.mkdir(requestedCache, { recursive: true });
  // Use a physical entry path: node_modules may be a Windows junction, which
  // would make import.meta.url differ from argv and hide the original bug.
  const cache = await fs.realpath(requestedCache);
  const temporary = await fs.mkdtemp(path.join(cache, "yzt-recovery-entry-"));
  try {
    const outfile = path.join(temporary, "recovery-job.mjs");
    await build({
      entryPoints: ["tools/recovery-job.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile,
    });
    const result = spawnSync(process.execPath, [outfile], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        RECOVERY_PLAN_JSON: "{}",
        GOOGLE_APPLICATION_CREDENTIALS: path.join(
          temporary,
          "no-credentials.json",
        ),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const events = result.stderr
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        severity: "ERROR",
        event: "recovery_backup_failed",
        code: "invalid_recovery_plan_resources",
      },
    ]);
  } finally {
    if (
      path.dirname(path.resolve(temporary)) !== cache ||
      !path.basename(temporary).startsWith("yzt-recovery-entry-")
    )
      throw Error("unsafe_build_test_cleanup_path");
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
