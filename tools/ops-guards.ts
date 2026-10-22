export interface RestorePlan {
  project: string;
  region: string;
  sourceDatabase: string;
  sourceDatabaseUid: string;
  sourceBackup: string;
  targetDatabase: string;
  limits: {
    restoreRequests: number;
    documentReadsUpper: number;
    targetHours: number;
  };
}
export interface DatabaseMetadata {
  name: string;
  uid: string;
  locationId: string;
}
export interface BackupMetadata {
  name: string;
  database: string;
  databaseUid: string;
  state: string;
  expireTime: string;
}
export function validateRestorePlan(value: unknown): RestorePlan {
  if (!value || typeof value !== "object") throw Error("invalid_restore_plan");
  const p = value as RestorePlan;
  if (
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(p.project || "") ||
    !/^[a-z]+-[a-z]+[0-9]$/u.test(p.region || "")
  )
    throw Error("invalid_project_or_region");
  const source = `projects/${p.project}/databases/(default)`;
  const backupPrefix = `projects/${p.project}/locations/${p.region}/backups/`;
  const targetPrefix = `projects/${p.project}/databases/`;
  if (
    p.sourceDatabase !== source ||
    !/^[a-f0-9-]{36}$/u.test(p.sourceDatabaseUid || "")
  )
    throw Error("source_identity_required");
  if (
    !p.sourceBackup?.startsWith(backupPrefix) ||
    !/^[a-f0-9-]{36}$/u.test(p.sourceBackup.slice(backupPrefix.length))
  )
    throw Error("backup_project_location_mismatch");
  if (
    !p.targetDatabase?.startsWith(targetPrefix) ||
    !/^restore-drill-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(
      p.targetDatabase.slice(targetPrefix.length),
    )
  )
    throw Error("target_must_be_named_isolated_drill");
  if (
    p.limits?.restoreRequests !== 1 ||
    !Number.isInteger(p.limits.documentReadsUpper) ||
    p.limits.documentReadsUpper < 1 ||
    p.limits.documentReadsUpper > 50000 ||
    !(p.limits.targetHours > 0 && p.limits.targetHours <= 2)
  )
    throw Error("restore_budget_invalid");
  return p;
}
export function verifyRestorePreflight(
  plan: RestorePlan,
  source: DatabaseMetadata,
  backup: BackupMetadata,
  destination: DatabaseMetadata | null,
  at = Date.now(),
) {
  validateRestorePlan(plan);
  if (destination) throw Error("destination_exists_no_restore");
  if (
    source.name !== plan.sourceDatabase ||
    source.uid !== plan.sourceDatabaseUid ||
    source.locationId !== plan.region
  )
    throw Error("source_metadata_mismatch");
  if (
    backup.name !== plan.sourceBackup ||
    backup.database !== plan.sourceDatabase ||
    backup.databaseUid !== source.uid ||
    backup.state !== "READY" ||
    !(Date.parse(backup.expireTime) > at)
  )
    throw Error("backup_not_ready_or_identity_mismatch");
  return {
    databaseId: plan.targetDatabase.split("/").at(-1)!,
    backup: plan.sourceBackup,
  };
}
export interface OperationalPolicy {
  displayName: string;
  enabled: boolean;
  notificationChannels?: string[];
  conditions: unknown[];
  [key: string]: unknown;
}
export function validateSilentPolicies(policies: OperationalPolicy[]) {
  if (
    policies.length !== 3 ||
    new Set(policies.map((p) => p.displayName)).size !== 3
  )
    throw Error("expected_three_distinct_policies");
  for (const p of policies)
    if (
      !p.enabled ||
      (p.notificationChannels || []).length ||
      !p.conditions.length
    )
      throw Error("policies_must_be_enabled_without_channels");
  return policies;
}
export function planPolicyCreates(
  desired: OperationalPolicy[],
  existing: OperationalPolicy[],
) {
  validateSilentPolicies(desired);
  // Never silently patch/delete a policy created by another operator.
  if (
    desired.some((p) => existing.some((q) => p.displayName === q.displayName))
  )
    throw Error("same_policy_name_exists_read_and_review_no_duplicate");
  return desired;
}
export function verifySilentPolicyReadback(
  expected: OperationalPolicy,
  actual: OperationalPolicy,
) {
  const contains = (wanted: unknown, got: unknown): boolean =>
    Array.isArray(wanted)
      ? Array.isArray(got) &&
        wanted.length === got.length &&
        wanted.every((item, index) => contains(item, got[index]))
      : wanted !== null && typeof wanted === "object"
        ? got !== null &&
          typeof got === "object" &&
          Object.entries(wanted).every(([key, value]) =>
            contains(value, (got as Record<string, unknown>)[key]),
          )
        : wanted === got;
  if (
    actual.displayName !== expected.displayName ||
    actual.enabled !== true ||
    (actual.notificationChannels || []).length ||
    actual.combiner !== expected.combiner ||
    !contains(expected.conditions, actual.conditions) ||
    !contains(expected.alertStrategy, actual.alertStrategy)
  )
    throw Error("policy_readback_mismatch");
  return true;
}
export function exceedsForSamples(
  values: number[],
  threshold: number,
  consecutiveSamples: number,
) {
  let count = 0;
  return values.some(
    (value) =>
      (count = value > threshold ? count + 1 : 0) >= consecutiveSamples,
  );
}
