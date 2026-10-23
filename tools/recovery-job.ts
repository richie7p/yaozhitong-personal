import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { validateRecoveryPlan } from "./recovery-core.js";
import { performCompleteBackup } from "./recovery-backup.js";

async function main() {
  const plan = validateRecoveryPlan(JSON.parse(process.env.RECOVERY_PLAN_JSON || "null"));
  const receipts = await fs.mkdtemp(path.join(os.tmpdir(), "yzt-backup-"));
  const result = await performCompleteBackup(plan, receipts, true);
  console.log(JSON.stringify({severity:"INFO",event:"recovery_backup_complete",runId:randomUUID(),...result}));
}
main().catch(error => {
  const message=String(error?.message||"");
  console.error(JSON.stringify({severity:"ERROR",event:"recovery_backup_failed",code:/^[a-zA-Z0-9_]+$/.test(message)?message:"recovery_failed_redacted"}));
  process.exitCode=1;
});
