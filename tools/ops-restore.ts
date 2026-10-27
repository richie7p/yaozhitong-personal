import { GoogleAuth } from "google-auth-library";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateRestorePlan,
  verifyRestorePreflight,
  type DatabaseMetadata,
  type BackupMetadata,
} from "./ops-guards.js";

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1]) throw Error("missing_argument");
    return args[i + 1];
  };
  const bytes = await fs.readFile(path.resolve(value("--plan")));
  const plan = validateRestorePlan(JSON.parse(bytes.toString("utf8")));
  const planSha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = path.resolve(value("--receipts"));
  await fs.mkdir(directory, { recursive: true });
  const journalPath = path.join(directory, "restore-operation.json");
  try {
    await fs.access(journalPath);
    throw Error("journal_exists_no_retry_reconcile_readonly");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const client = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  async function get<T>(resource: string): Promise<T | null> {
    try {
      return (
        await client.request<T>({
          url: "https://firestore.googleapis.com/v1/" + resource,
          method: "GET",
          retry: false,
          timeout: 45000,
        })
      ).data;
    } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status === 404)
        return null;
      throw Error("cloud_read_failed");
    }
  }
  const [source, backup, target] = await Promise.all([
    get<DatabaseMetadata>(plan.sourceDatabase),
    get<BackupMetadata>(plan.sourceBackup),
    get<DatabaseMetadata>(plan.targetDatabase),
  ]);
  if (!source || !backup) throw Error("source_or_backup_absent");
  const body = verifyRestorePreflight(plan, source, backup, target);
  await fs.writeFile(
    path.join(
      directory,
      args.includes("--execute")
        ? "restore-preflight-execute.json"
        : "restore-preflight-readonly.json",
    ),
    JSON.stringify(
      {
        planSha256,
        source,
        backup,
        targetWasAbsent: true,
        execute: args.includes("--execute"),
        at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  if (!args.includes("--execute")) {
    console.log(
      JSON.stringify({
        status: "read_only_preflight_pass",
        planSha256,
        source: plan.sourceDatabase,
        target: plan.targetDatabase,
        cloudMutations: 0,
      }),
    );
    return;
  }
  type Operation = {
    name: string;
    done?: boolean;
    error?: unknown;
    [key: string]: unknown;
  };
  const journal: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    planSha256,
    source: plan.sourceDatabase,
    target: plan.targetDatabase,
    sourceUid: source.uid,
    restoreRequests: 1,
    status: "single_request_intent_frozen",
    defaultWrites: 0,
    validationPerformed: false,
    cleanupPerformed: false,
  };
  await fs.writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n", {
    flag: "wx",
  });
  const save = () =>
    fs.writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  let operation: Operation;
  try {
    operation = (
      await client.request<Operation>({
        url: `https://firestore.googleapis.com/v1/projects/${plan.project}/databases:restore`,
        method: "POST",
        data: body,
        retry: false,
        timeout: 60000,
      })
    ).data;
  } catch {
    journal.status = "uncertain_stop_no_retry";
    await save();
    throw Error("restore_outcome_uncertain_readonly_reconciliation_required");
  }
  journal.operation = operation;
  await save();
  if (!operation.name.startsWith(plan.targetDatabase + "/operations/"))
    throw Error("unexpected_operation_identity_stop");
  const deadline = Date.now() + plan.limits.targetHours * 3600000;
  while (!operation.done) {
    if (Date.now() >= deadline) {
      journal.status = "wait_limit_operation_preserved";
      await save();
      throw Error("restore_wait_limit_no_automatic_cleanup");
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const read = await get<Operation>(operation.name);
    if (!read) throw Error("operation_missing_stop");
    operation = read;
    journal.operation = operation;
    journal.lastPolledAt = new Date().toISOString();
    await save();
  }
  const afterSource = await get<DatabaseMetadata>(plan.sourceDatabase);
  if (afterSource?.uid !== source.uid) throw Error("default_identity_changed");
  journal.targetMetadata = await get<DatabaseMetadata>(plan.targetDatabase);
  journal.defaultUidUnchanged = true;
  journal.status = operation.error
    ? "restore_failed"
    : "restore_completed_requires_data_validation";
  journal.completedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      status: journal.status,
      journalPath,
      planSha256,
      cleanupPerformed: false,
    }),
  );
  if (operation.error) process.exitCode = 2;
}
main().catch(() => {
  console.error("ops_restore_failed_inspect_private_journal_no_blind_retry");
  process.exitCode = 1;
});
