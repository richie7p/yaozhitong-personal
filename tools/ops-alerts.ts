import { GoogleAuth } from "google-auth-library";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  planPolicyCreates,
  validateSilentPolicies,
  verifySilentPolicyReadback,
  type OperationalPolicy,
} from "./ops-guards.js";

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1]) throw Error("missing_argument");
    return args[i + 1];
  };
  const project = value("--project");
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(project))
    throw Error("invalid_project");
  const bytes = await fs.readFile(path.resolve(value("--config"))),
    parsed = JSON.parse(bytes.toString("utf8"));
  const policies = validateSilentPolicies(
    parsed.policies as OperationalPolicy[],
  );
  const configSha256 = createHash("sha256").update(bytes).digest("hex");
  const client = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  const url = `https://monitoring.googleapis.com/v3/projects/${project}/alertPolicies`;
  const before = (
    await client.request<{
      alertPolicies?: OperationalPolicy[];
      nextPageToken?: string;
    }>({ url, method: "GET", retry: false, timeout: 45000 })
  ).data;
  if (before.nextPageToken) throw Error("policy_pagination_requires_review");
  planPolicyCreates(policies, before.alertPolicies || []);
  if (!args.includes("--apply")) {
    console.log(
      JSON.stringify({
        status: "read_only_plan_ready",
        configSha256,
        policies: policies.map((p) => p.displayName),
        channels: 0,
        cloudMutations: 0,
      }),
    );
    return;
  }
  const receipt = path.resolve(value("--receipt"));
  const journal = {
    schema: "silent-alert-rule-create/v1",
    project,
    configSha256,
    existingPoliciesPreserved: true,
    channelsCreated: 0,
    notificationsSent: 0,
    inFlight: "",
    created: [] as unknown[],
  };
  await fs.writeFile(receipt, JSON.stringify(journal, null, 2) + "\n", {
    flag: "wx",
  });
  for (const policy of policies) {
    journal.inFlight = policy.displayName;
    await fs.writeFile(receipt, JSON.stringify(journal, null, 2) + "\n");
    const created = (
      await client.request<OperationalPolicy & { name: string }>({
        url,
        method: "POST",
        data: policy,
        retry: false,
        timeout: 45000,
      })
    ).data;
    const read = (
      await client.request<OperationalPolicy>({
        url: "https://monitoring.googleapis.com/v3/" + created.name,
        method: "GET",
        retry: false,
        timeout: 45000,
      })
    ).data;
    verifySilentPolicyReadback(policy, read);
    journal.created.push(read);
    journal.inFlight = "";
    await fs.writeFile(receipt, JSON.stringify(journal, null, 2) + "\n");
  }
  console.log(
    JSON.stringify({
      status: "created_read_back",
      configSha256,
      created: journal.created.length,
      channels: 0,
      notificationsSent: 0,
    }),
  );
}
main().catch(() => {
  console.error("ops_alerts_failed_inspect_private_journal_no_blind_retry");
  process.exitCode = 1;
});
