/** Preview by default. --apply updates only the project's password policy. */
import {
  initializeApp,
  applicationDefault,
  deleteApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
const project = process.argv
  .find((arg) => arg.startsWith("--project="))
  ?.slice(10);
if (!project || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) {
  console.error("Use --project=PROJECT_ID and optionally --apply.");
  process.exit(1);
}
const app = initializeApp({
  credential: applicationDefault(),
  projectId: project,
});
try {
  const manager = getAuth(app).projectConfigManager();
  const before = await manager.getProjectConfig();
  const existing = before.passwordPolicyConfig;
  const desired = {
    enforcementState: "ENFORCE" as const,
    forceUpgradeOnSignin: existing?.forceUpgradeOnSignin ?? false,
    constraints: {
      ...existing?.constraints,
      minLength: Math.max(8, existing?.constraints?.minLength ?? 0),
    },
  };
  const apply = process.argv.includes("--apply");
  if (apply)
    await manager.updateProjectConfig({ passwordPolicyConfig: desired });
  const after = apply ? await manager.getProjectConfig() : before;
  const unchanged =
    JSON.stringify(before.emailPrivacyConfig) ===
      JSON.stringify(after.emailPrivacyConfig) &&
    JSON.stringify(before.recaptchaConfig) ===
      JSON.stringify(after.recaptchaConfig);
  if (!unchanged) throw Error("unrelated_auth_policy_changed");
  console.log(
    JSON.stringify({
      project,
      applied: apply,
      before: before.passwordPolicyConfig ?? null,
      after: after.passwordPolicyConfig ?? null,
      desired,
      otherPoliciesUnchanged: unchanged,
      emailsSent: 0,
      usersChanged: 0,
    }),
  );
} catch (error) {
  // SDK errors can include request details. Keep them out of terminal output.
  const code = (error as { code?: string }).code;
  console.error(
    JSON.stringify({
      error: "auth_policy_operation_failed",
      code: code && /^[a-z/-]+$/.test(code) ? code : "unavailable",
    }),
  );
  process.exitCode = 1;
} finally {
  await deleteApp(app);
}
