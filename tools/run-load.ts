import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLOUD_READ_PATHS,
  LoadMetrics,
  LoadPlanSchema,
  measuredRequest,
  runVirtualUsers,
  type LoadPlan,
} from "./load-core.js";

async function cloudReads(plan: LoadPlan, credentialsPath: string) {
  // Login is the ordinary sign-in flow. It can update Auth's last-login metadata;
  // this runner sends no application mutation request and creates no account.
  const privateState = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  if (
    privateState.projectId !== plan.project ||
    !privateState.owner?.password ||
    !privateState.owner?.email ||
    !privateState.owner?.uid
  )
    throw Error("private_credentials_wrong_scope");
  const configuration = await fetch(plan.origin + "/api/v1/config", {
    signal: AbortSignal.timeout(plan.requestTimeoutMs),
    redirect: "error",
  });
  if (!configuration.ok) throw Error("public_configuration_unavailable");
  const publicConfig = await configuration.json();
  if (
    publicConfig.firebase?.projectId !== plan.project ||
    publicConfig.publicAccess !== "verified" ||
    publicConfig.dailyUserLimit !== 20 ||
    publicConfig.dailyGlobalLimit !== 1000
  )
    throw Error("cloud_project_or_quota_changed");
  const signedIn = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" +
      encodeURIComponent(publicConfig.firebase.apiKey),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: privateState.owner.email,
        password: privateState.owner.password,
        returnSecureToken: true,
      }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  if (!signedIn.ok) throw Error("ordinary_login_failed");
  const credentials = await signedIn.json();
  if (!credentials.idToken || credentials.localId !== privateState.owner.uid)
    throw Error("ordinary_login_identity_mismatch");
  const token: string = credentials.idToken;
  const profiles = [];
  for (const profile of plan.profiles) {
    const metrics = new LoadMetrics(plan);
    const started = performance.now();
    await runVirtualUsers(
      profile.virtualUsers,
      profile.requests,
      () => !!metrics.stopReason,
      async (user, iteration) => {
        const endpoint =
          CLOUD_READ_PATHS[
            (iteration * profile.virtualUsers + user) % CLOUD_READ_PATHS.length
          ];
        await measuredRequest(metrics, plan.origin, {
          label: "GET " + endpoint,
          path: endpoint,
          token,
          timeoutMs: plan.requestTimeoutMs,
          invariant: (value) =>
            endpoint === "/me"
              ? value.account?.id === privateState.owner.uid &&
                value.account?.admin === false &&
                !value.account.disabled &&
                !value.account.deleting
              : !Array.isArray(value.items) ||
                value.items.every(
                  (row: any) =>
                    row.ownerId === undefined ||
                    row.ownerId === privateState.owner.uid,
                ),
        });
      },
      profile.thinkTimeMs,
    );
    const elapsedMs = performance.now() - started;
    const result = {
      virtualUsers: profile.virtualUsers,
      durationMs: Math.round(elapsedMs),
      requestsPerSecond:
        Math.round((metrics.samples.length / elapsedMs) * 100000) / 100,
      ...metrics.summary(),
    };
    profiles.push(result);
    if (result.stopReason || result.unexpectedResponses) break;
  }
  return {
    scenario: "same_existing_owner_read_burst",
    genuineIndependentCloudUsers: 1,
    ordinarySignIns: 1,
    syntheticAccountsCreated: 0,
    applicationMutationRequests: 0,
    aiJobsCreated: 0,
    providerCalls: 0,
    quotaResets: 0,
    expectedQuota: { dailyPerPerson: 20, dailySiteWide: 1000 },
    profiles,
    limitations: [
      "The virtual clients share one existing synthetic owner. This is a bounded deployment read check, not independent-user cloud capacity or native AI queue throughput.",
    ],
  };
}

export async function main(args = process.argv.slice(2)) {
  const permitted = new Set([
    "--plan",
    "--out",
    "--credentials",
    "--catalog",
    "--execute-cloud-reads",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (!permitted.has(args[i])) throw Error("unknown_argument");
    if (args[i] !== "--execute-cloud-reads") i++;
  }
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--"))
      throw Error("missing_argument");
    return path.resolve(args[i + 1]);
  };
  const bytes = await fs.readFile(value("--plan"));
  const plan = LoadPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
  const out = value("--out");
  await fs.mkdir(path.dirname(out), { recursive: true });
  const file = await fs.open(out, "wx");
  const startedAt = new Date().toISOString();
  const sourceRoot = new URL("../", import.meta.url);
  const pinPaths = [
    "tools/run-load.ts",
    "tools/load-core.ts",
    ...(plan.mode === "emulator"
      ? [
          "tools/load-emulator.ts",
          "tools/load-photo.ts",
          "server/app.ts",
          "server/domain.ts",
          "server/auth.ts",
          "server/store.ts",
          "server/config.ts",
          "server/catalog.ts",
          "server/job-queue.ts",
          "server/admission.ts",
          "server/photo-validation.ts",
          "server/source-teaching.ts",
          "server/source-review-result.ts",
          "server/ai.ts",
          "shared/product-identity.ts",
        ]
      : []),
  ];
  const pins = async () =>
    Object.fromEntries(
      await Promise.all(
        pinPaths.map(async (rel) => [
          rel,
          createHash("sha256")
            .update(await fs.readFile(new URL(rel, sourceRoot)))
            .digest("hex"),
        ]),
      ),
    );
  const sourcePinsBefore = await pins();
  let report: any;
  try {
    if (
      plan.mode === "cloud-readonly" &&
      !args.includes("--execute-cloud-reads")
    ) {
      report = {
        status: "prepared_readonly_execution_not_requested",
        plan,
        applicationMutationRequests: 0,
        providerCalls: 0,
      };
    } else {
      const result =
        plan.mode === "cloud-readonly"
          ? await cloudReads(plan, value("--credentials"))
          : await (
              await import("./load-emulator.js")
            ).runEmulatorLoad(plan, {
              catalogPath: args.includes("--catalog")
                ? value("--catalog")
                : undefined,
            });
      report = {
        ...result,
        status:
          result.profiles.every(
            (p: any) => !p.stopReason && !p.unexpectedResponses,
          ) && !(result as any).invariantFailure
            ? "passed_bounded_load"
            : "failed_load_checks",
      };
      if (report.status !== "passed_bounded_load") process.exitCode = 1;
    }
  } catch {
    report = {
      status: "runner_failed_see_private_setup",
      error: "load_execution_failed",
      providerCalls: 0,
    };
    process.exitCode = 1;
  } finally {
    const sourcePinsAfter = await pins();
    const sourceFilesStableDuringRun =
      JSON.stringify(sourcePinsBefore) === JSON.stringify(sourcePinsAfter);
    if (!sourceFilesStableDuringRun) {
      report.status = "source_changed_during_run";
      process.exitCode = 1;
    }
    report = {
      schema: "yzt-load-receipt/v1",
      startedAt,
      completedAt: new Date().toISOString(),
      planSha256: createHash("sha256").update(bytes).digest("hex"),
      mode: plan.mode,
      sourcePinScope:
        plan.mode === "emulator"
          ? "local_server_and_controller"
          : "controller_only_not_remote_revision",
      sourcePinsBefore,
      sourcePinsAfter,
      sourceFilesStableDuringRun,
      ...report,
    };
    await file.writeFile(JSON.stringify(report, null, 2) + "\n");
    await file.close();
  }
  console.log(
    JSON.stringify({
      status: report.status,
      mode: plan.mode,
      profiles: report.profiles?.map((p: any) => ({
        virtualUsers: p.virtualUsers,
        requests: p.requests,
        p95Ms: p.p95Ms,
        unexpectedResponses: p.unexpectedResponses,
        stopReason: p.stopReason,
      })),
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error("load_preparation_failed");
    process.exitCode = 1;
  });
