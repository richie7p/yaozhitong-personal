/** Prepare a checkpoint, then verify it after an actual Windows boot. No external AI calls. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";

const mode = process.argv[2];
if (mode !== "prepare" && mode !== "verify")
  throw Error("Use prepare or verify.");
const directory = resolve(
  process.argv[3] || ".local/seminar-demo-expanded-v13-20261020",
);
const rel = relative(resolve(".local"), directory);
if (!rel || rel.startsWith("..") || isAbsolute(rel))
  throw Error("Use an isolated demonstration directory inside .local.");
const checkpointFile = join(directory, "windows-reboot-checkpoint.json");
const bootId = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
  ],
  { windowsHide: true, encoding: "utf8" },
).trim();
const db = JSON.parse(await readFile(join(directory, "db.json"), "utf8"));
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value: any) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const collections = [
  "medications",
  "learning",
  "generated",
  "jobs",
  "profiles",
  "schedules",
];
const hashes = Object.fromEntries(
  collections.map((key) => [
    key,
    digest(
      key === "schedules"
        ? Object.fromEntries(
            Object.entries(db[key] || {}).map(([id, value]) => {
              const { nextAt, ...savedSchedule } = value as any;
              return [id, savedSchedule];
            }),
          )
        : db[key] || {},
    ),
  ]),
);
if (mode === "prepare") {
  if (
    Object.values(db.jobs || {}).some((j: any) =>
      ["queued", "running"].includes(j.status),
    )
  )
    throw Error(
      "Finish all demonstration jobs before preparing a reboot checkpoint.",
    );
  await writeFile(
    checkpointFile,
    JSON.stringify(
      { preparedAt: new Date().toISOString(), bootId, hashes, directory },
      null,
      2,
    ),
  );
  console.log(
    "Windows reboot checkpoint prepared. This does not confirm a reboot has occurred.",
  );
} else {
  const prior = JSON.parse(await readFile(checkpointFile, "utf8"));
  if (resolve(prior.directory).toLowerCase() !== directory.toLowerCase())
    throw Error("The reboot checkpoint belongs to a different data directory.");
  const port = Number(process.argv[4] || 8085);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Invalid port");
  const launcher = JSON.parse(
    (await readFile(`.local/launcher/server-${port}.json`, "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  if (
    resolve(launcher.dataPath).toLowerCase() !== directory.toLowerCase() ||
    !Number.isInteger(launcher.pid) ||
    launcher.pid < 1
  )
    throw Error(
      "The demonstration launcher is using a different data directory.",
    );
  const liveStart = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$process = Get-Process -Id ${launcher.pid} -ErrorAction Stop; $listener = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq ${launcher.pid} }; if (-not $listener) { throw 'The launcher process does not own this port.' }; $process.StartTime.ToUniversalTime().ToString('o')`,
    ],
    { windowsHide: true, encoding: "utf8" },
  ).trim();
  if (liveStart !== launcher.processStart)
    throw Error(
      "The demonstration process identity no longer matches its launcher.",
    );
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(base + "/api/v1/auth/local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "local-owner" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!login.ok) throw Error("Local demonstration sign-in failed");
  const { token } = await login.json();
  const read = async (path: string) => {
    const r = await fetch(base + "/api/v1" + path, {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw Error("Demonstration read failed: " + path);
    return r.json();
  };
  const [medications, learning] = await Promise.all([
    read("/medications"),
    read("/learning"),
  ]);
  const changedCollections = collections.filter(
    (key) => hashes[key] !== prior.hashes[key],
  );
  const sorted = (items: any[]) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  const learningFields = (items: any[]) =>
    sorted(
      items.map((r) => ({
        id: r.id,
        result: r.result,
        answers: r.answers,
        groundingVersion: r.groundingVersion,
      })),
    );
  const liveDataMatches =
    digest(sorted(medications.items)) ===
      digest(
        sorted(
          Object.values(db.medications || {}).filter((m: any) => !m.archived),
        ),
      ) &&
    digest(learningFields(learning.items)) ===
      digest(learningFields(Object.values(db.learning || {})));
  const osRebooted = bootId !== prior.bootId;
  const report = {
    checkedAt: new Date().toISOString(),
    directory,
    port,
    osRebooted,
    sameWindowsBoot: !osRebooted,
    changedCollections,
    liveDataMatches,
    launcherIdentityMatches: true,
    scheduleCheck:
      "Persisted user schedule settings; automatic nextAt advancement excluded",
    medications: medications.items.length,
    learning: learning.items.length,
    status:
      changedCollections.length || !liveDataMatches
        ? "failed"
        : osRebooted
          ? "passed"
          : "pending_actual_windows_reboot",
  };
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/seminar-windows-reboot.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}
