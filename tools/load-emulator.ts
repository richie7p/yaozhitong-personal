import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Server } from "node:http";
import {
  LoadMetrics,
  measuredRequest,
  runVirtualUsers,
  type LoadPlan,
} from "./load-core.js";

/** Only synthetic data in a demo project, using the shipped Auth and Firestore adapters. */
export async function runEmulatorLoad(
  plan: LoadPlan,
  options: { catalogPath?: string } = {},
) {
  if (
    plan.mode !== "emulator" ||
    !plan.project.startsWith("demo-") ||
    new URL(plan.origin).hostname !== "127.0.0.1"
  )
    throw Error("emulator_scope_required");
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (
    ![authHost, firestoreHost].every((host) =>
      /^127\.0\.0\.1:\d{2,5}$/.test(host || ""),
    )
  )
    throw Error("both_loopback_emulators_required");
  if (
    process.env.GOOGLE_CLOUD_PROJECT &&
    process.env.GOOGLE_CLOUD_PROJECT !== plan.project
  )
    throw Error("emulator_project_mismatch");
  Object.assign(process.env, {
    APP_MODE: "firebase",
    GOOGLE_CLOUD_PROJECT: plan.project,
    STORAGE_BUCKET: plan.project + ".appspot.com",
    PUBLIC_ACCESS_MODE: "verified",
    DAILY_USER_LIMIT: "20",
    DAILY_GLOBAL_LIMIT: "1000",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "",
    NVIDIA_API_KEY: "",
    SERVICE_ROLE: "web",
  });
  const [
    { serve },
    { Domain, hash },
    { FirestoreStore, firebaseApp },
    { getAuth },
    { deleteApp },
    { MedicationSchema },
    { GROUNDING_VERSION },
    { CloudJobQueue, dispatchTaskId },
    { DateTime },
  ] = await Promise.all([
    import("@hono/node-server"),
    import("../server/domain.js"),
    import("../server/store.js"),
    import("firebase-admin/auth"),
    import("firebase-admin/app"),
    import("../shared/schema.js"),
    import("../server/ai.js"),
    import("../server/job-queue.js"),
    import("luxon"),
  ]);
  const { createApp } = await import("../server/app.js");
  const { Blobs } = await import("../server/blobs.js");
  const store = new FirestoreStore();
  const auth = getAuth(firebaseApp());
  const run = randomBytes(6).toString("hex");
  const createdAt = new Date().toISOString();
  const day = DateTime.now().setZone("Asia/Taipei").toISODate()!;
  const globalKey = "global-" + day;
  const drug = {
    licenseNo: "SYNTHETIC-LOAD-LICENSE",
    nameZh: "Synthetic load fixture",
    nameEn: "SYNTHETIC LOAD FIXTURE",
    strength: "",
    form: "tablet",
    ingredients: [],
    revoked: false,
  };
  const suppliedCatalog = options.catalogPath
    ? await fs.readFile(options.catalogPath)
    : undefined;
  const catalogRows: any[] = suppliedCatalog
    ? JSON.parse(suppliedCatalog.toString("utf8"))
    : [];
  if (
    !Array.isArray(catalogRows) ||
    catalogRows.some(
      (row) =>
        typeof row.licenseNo !== "string" ||
        typeof row.nameZh !== "string" ||
        !Array.isArray(row.ingredients),
    )
  )
    throw Error("emulator_invalid_catalog");
  const catalogBytes = Buffer.from(JSON.stringify([...catalogRows, drug]));
  let catalogBlobReads = 0;
  const imageBlobs = new Map<string, Buffer>();
  class FixtureBlobs extends Blobs {
    async get(key: string) {
      if (imageBlobs.has(key)) return imageBlobs.get(key)!;
      if (key !== "synthetic/catalog.json") throw Error("unexpected_blob_read");
      catalogBlobReads++;
      return catalogBytes;
    }
    async put(key: string, data: Buffer): Promise<string> {
      if (!key.startsWith("uploads/synthetic-load-"))
        throw Error("blob_write_not_in_load_scope");
      imageBlobs.set(key, Buffer.from(data));
      return key;
    }
    async delete(key: string): Promise<void> {
      if (!key.startsWith("uploads/synthetic-load-"))
        throw Error("blob_delete_not_in_load_scope");
      imageBlobs.delete(key);
    }
  }
  let fakeProviderCalls = 0;
  const domain = new Domain(store, new FixtureBlobs(), () => ({
    json: async () => {
      fakeProviderCalls++;
      throw Error("provider_not_expected");
    },
  }));
  const users: {
    uid: string;
    token: string;
    medId: string;
    jobId: string;
    learningId: string;
    chatId: string;
  }[] = [];
  const tasks = new Map<string, string>(),
    tombstones = new Set<string>();
  let createRpc = 0,
    callbackCalls = 0,
    failCreate: "none" | "before" | "after" = "none";
  const transport = {
    async create(id: string, jobId: string) {
      createRpc++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (tasks.has(id) || tombstones.has(id))
        throw Object.assign(Error("already_exists"), { code: 6 });
      if (failCreate === "before") {
        failCreate = "none";
        throw Object.assign(Error("unavailable"), { code: 14 });
      }
      tasks.set(id, jobId);
      if (failCreate === "after") {
        failCreate = "none";
        throw Object.assign(Error("deadline"), { code: 4 });
      }
    },
    async exists(id: string) {
      return tasks.has(id);
    },
  };
  const queues = [
    new CloudJobQueue(store, transport),
    new CloudJobQueue(store, transport),
  ];
  domain.enqueue = async (id) =>
    queues[callbackCalls++ % queues.length].enqueue(id);
  let app = createApp(domain);
  let server: Server | undefined;
  let secondServer: Server | undefined;
  const profiles: any[] = [],
    controls: any[] = [];
  let boundaryMetrics: LoadMetrics | undefined;
  let phase = "setup";
  const errors: Record<string, number> = {};
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    try {
      const row = JSON.parse(String(args[0]));
      const code =
        typeof row.code === "string" && /^[a-z0-9_]{1,80}$/.test(row.code)
          ? row.code
          : "sanitized_server_log";
      errors[code] = (errors[code] || 0) + 1;
      if (
        typeof row.causeCode === "number" ||
        (typeof row.causeCode === "string" &&
          /^[A-Z0-9_]{1,50}$/.test(row.causeCode))
      ) {
        const cause = code + ":" + String(row.causeCode);
        errors[cause] = (errors[cause] || 0) + 1;
      }
    } catch {
      errors.sanitized_server_log = (errors.sanitized_server_log || 0) + 1;
    }
  };
  const ensure: (value: unknown, code: string) => asserts value = (
    value,
    code,
  ) => {
    if (!value) throw Error(code);
  };
  const password = "Synthetic-load-only-" + randomBytes(16).toString("hex");
  const signIn = async (email: string) => {
    const response = await fetch(
      `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic-emulator-api-key`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw Error("emulator_login_failed");
    const result = await response.json();
    if (!result.idToken) throw Error("emulator_login_missing_token");
    return result.idToken as string;
  };
  const medInput = MedicationSchema.parse({
    name: drug.nameZh,
    licenseNo: drug.licenseNo,
    identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    doseAmount: 1,
    doseUnit: "tablet",
    frequencyRaw: "QD",
    confirmed: true,
  });
  const start = async () => {
    server = serve({
      fetch: (...args) => app.fetch(...args),
      hostname: "127.0.0.1",
      port: Number(new URL(plan.origin).port),
    }) as Server;
    if (!server.listening) await once(server, "listening");
  };
  const stop = async () => {
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
  };
  try {
    await store.set("settings", "catalog", {
      version: "synthetic-load-v1",
      path: "synthetic/catalog.json",
    });
    await store.set("settings", "testerSeats", {
      uids: Array.from(
        { length: 50 },
        (_, i) => "synthetic-existing-seat-" + i,
      ),
    });
    // A separate identity owns quota-boundary fixtures; the first 100 remain
    // available for genuinely distinct concurrent admissions.
    const count = Math.max(101, ...plan.profiles.map((p) => p.virtualUsers));
    for (let offset = 0; offset < count; offset += 8) {
      await Promise.all(
        Array.from({ length: Math.min(8, count - offset) }, async (_, j) => {
          const index = offset + j;
          const uid = "synthetic-load-" + run + "-" + index;
          const email = uid + "@example.invalid";
          await auth.createUser({
            uid,
            email,
            emailVerified: true,
            password,
            displayName: "Synthetic user " + index,
          });
          const token = await signIn(email);
          await domain.account({
            uid,
            email,
            name: "Synthetic user " + index,
            verified: true,
            admin: false,
          });
          users[index] = {
            uid,
            token,
            medId: uid + "-med",
            jobId: uid + "-bundle",
            learningId: uid + "-bundle",
            chatId: uid + "-chat",
          };
        }),
      );
    }
    const writes: { c: string; id: string; value: any }[] = [];
    for (const user of users) {
      const medication = {
        ...medInput,
        id: user.medId,
        ownerId: user.uid,
        revision: 1,
        archived: false,
        createdAt,
        updatedAt: createdAt,
      };
      writes.push({ c: "medications", id: user.medId, value: medication });
      for (let i = 0; i < 5; i++) {
        const result = {
          status: "supported",
          claims: [],
          chunks: [],
          quiz: [
            {
              id: "synthetic-q1",
              question: "Synthetic software check A",
              options: ["A", "B"],
              answer: 0,
              explain: "Synthetic fixture, not medical advice.",
              citations: [],
            },
            {
              id: "synthetic-q2",
              question: "Synthetic software check B",
              options: ["A", "B"],
              answer: 1,
              explain: "Synthetic fixture, not medical advice.",
              citations: [],
            },
          ],
          followups: [],
          rejectedCount: 0,
          sourceVersions: {},
          verification: "model_assisted",
        };
        const record = {
          ownerId: user.uid,
          medicationIds: [user.medId],
          medicationRevisions: [{ id: user.medId, revision: 1 }],
          profileVersion: 0,
          groundingVersion: GROUNDING_VERSION,
          result,
          createdAt,
        };
        for (const kind of ["bundle", "chat"] as const) {
          const id = user.uid + "-" + kind + (i ? "-" + i : "");
          writes.push({
            c: kind === "chat" ? "chats" : "learning",
            id,
            value: {
              ...record,
              id,
              ...(kind === "chat"
                ? { question: "Synthetic question " + user.uid }
                : { answers: {} }),
            },
          });
          writes.push({
            c: "jobs",
            id,
            value: {
              id,
              ownerId: user.uid,
              kind,
              status: "succeeded",
              input: {},
              result,
              error: null,
              createdAt,
              updatedAt: createdAt,
              attempts: 1,
              leaseUntil: 0,
            },
          });
        }
      }
    }
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = store.db.batch();
      for (const row of writes.slice(offset, offset + 400))
        batch.set(store.db.collection(row.c).doc(row.id), row.value);
      await batch.commit();
    }
    await start();
    const warmup = new LoadMetrics(plan);
    ensure(
      (
        await measuredRequest(warmup, plan.origin, {
          label: "warmup",
          path: "/me",
          token: users[0].token,
          timeoutMs: plan.requestTimeoutMs,
          invariant: (b) => b.account?.id === users[0].uid,
        })
      ).expected,
      "emulator_auth_warmup_failed",
    );
    if (suppliedCatalog) {
      phase = "full_catalog_search_baseline";
      const search = new LoadMetrics(plan);
      for (const query of ["Kentamin", "咳服", "安離痛"]) {
        await measuredRequest(search, plan.origin, {
          label: "full_catalog_search",
          path: "/drugs/search?q=" + encodeURIComponent(query),
          token: users[0].token,
          timeoutMs: plan.requestTimeoutMs,
          invariant: (b) => Array.isArray(b.items) && b.items.length <= 12,
        });
      }
      controls.push({
        name: "full_catalog_single_user_search",
        actualPublicCatalogRows: catalogRows.length,
        ...search.summary(),
        catalogBlobReads,
      });
      console.log(
        JSON.stringify({
          progress: "full_catalog_search_baseline",
          catalogRows: catalogRows.length,
          ...search.summary(),
          catalogBlobReads,
        }),
      );
    }
    for (const profile of plan.profiles) {
      phase = "profile_" + profile.virtualUsers;
      const metrics = new LoadMetrics(plan),
        local: { med?: any }[] = Array.from(
          { length: profile.virtualUsers },
          () => ({}),
        );
      const eventLoop = monitorEventLoopDelay({ resolution: 20 });
      eventLoop.enable();
      const startCpu = process.cpuUsage(),
        began = performance.now();
      await runVirtualUsers(
        profile.virtualUsers,
        profile.requests,
        () => !!metrics.stopReason,
        async (index, iteration) => {
          const user = users[index],
            other = users[(index + 1) % users.length],
            memory = local[index];
          const call = (
            label: string,
            pathname: string,
            extra: Partial<Parameters<typeof measuredRequest>[2]> = {},
          ) =>
            measuredRequest(metrics, plan.origin, {
              label,
              path: pathname,
              token: user.token,
              timeoutMs: plan.requestTimeoutMs,
              ...extra,
            });
          const owned = (body: any) =>
            Array.isArray(body.items) &&
            body.items.every((row: any) => row.ownerId === user.uid);
          switch (iteration % 20) {
            case 0:
              await call("me", "/me", {
                invariant: (b) =>
                  b.account?.id === user.uid && b.account.admin === false,
              });
              break;
            case 1:
              await call("medications", "/medications", { invariant: owned });
              break;
            case 2:
              await call("schedules", "/schedules", { invariant: owned });
              break;
            case 3:
              await call("learning", "/learning", {
                invariant: (b) => owned(b) && b.items.length === 5,
              });
              break;
            case 4:
              await call("chat", "/chat", {
                invariant: (b) =>
                  owned(b) &&
                  b.items.length === 5 &&
                  b.items.every((r: any) => r.question.includes(user.uid)),
              });
              break;
            case 5:
              await call("saved_bundle", "/jobs/" + user.jobId, {
                invariant: (b) =>
                  b.ownerId === user.uid &&
                  b.result.status === "supported" &&
                  !("input" in b),
              });
              break;
            case 6:
              await call("cross_owner_job", "/jobs/" + other.jobId, {
                expected: [404],
                invariant: (b) => b.code === "not_found",
              });
              break;
            case 7:
              await call("support", "/support", { invariant: owned });
              break;
            case 8:
              memory.med = (
                await call("create_medication", "/medications", {
                  method: "POST",
                  body: medInput,
                  expected: [201],
                  invariant: (b) => b.ownerId === user.uid && b.revision === 1,
                })
              ).data;
              break;
            case 9:
              if (memory.med?.id)
                await call("save_schedule", "/schedules", {
                  method: "POST",
                  body: {
                    medicationId: memory.med.id,
                    times: ["08:00"],
                    startDate: day,
                  },
                  expected: [201],
                  invariant: (b) =>
                    b.ownerId === user.uid && b.medicationId === memory.med.id,
                });
              break;
            case 10:
              if (memory.med?.id)
                await call("today_saved", "/today", {
                  invariant: (b) =>
                    b.items.some((r: any) => r.medicationId === memory.med.id),
                });
              break;
            case 11:
              if (memory.med?.id)
                await call(
                  "update_medication",
                  "/medications/" + memory.med.id,
                  {
                    method: "PUT",
                    body: {
                      ...medInput,
                      instructions: "Synthetic updated instruction",
                    },
                    invariant: (b) =>
                      b.ownerId === user.uid && b.revision === 2,
                  },
                );
              break;
            case 12:
              if (memory.med?.id)
                await call("today_revision_invalidated", "/today", {
                  invariant: (b) =>
                    !b.items.some((r: any) => r.medicationId === memory.med.id),
                });
              break;
            case 13:
              if (memory.med?.id)
                await call(
                  "delete_medication",
                  "/medications/" + memory.med.id,
                  { method: "DELETE", invariant: (b) => b.ok === true },
                );
              break;
            case 14:
              await call("medication_archive_visible", "/medications", {
                invariant: (b) =>
                  owned(b) &&
                  !b.items.some((r: any) => r.id === memory.med?.id),
              });
              break;
            case 15:
              await call(
                "cross_owner_medication_write",
                "/medications/" + other.medId,
                {
                  method: "PUT",
                  body: medInput,
                  expected: [404],
                  invariant: (b) => b.code === "not_found",
                },
              );
              break;
            case 16:
              await call("invalid_session", "/me", {
                token: "synthetic-invalid-token",
                expected: [401],
                invariant: (b) => b.code === "unauthenticated",
              });
              break;
            case 17:
              await call("admin_denied", "/admin/users", {
                expected: [403],
                invariant: (b) => b.code === "forbidden",
              });
              break;
            case 18:
              await call("dose_logs", "/dose-logs", { invariant: owned });
              break;
            case 19:
              await call("notifications", "/notifications", {
                invariant: owned,
              });
              break;
          }
        },
        profile.thinkTimeMs,
      );
      const elapsedMs = performance.now() - began,
        cpu = process.cpuUsage(startCpu);
      eventLoop.disable();
      profiles.push({
        virtualUsers: profile.virtualUsers,
        distinctOrdinaryIdentities: profile.virtualUsers,
        durationMs: Math.round(elapsedMs),
        requestsPerSecond:
          Math.round((metrics.samples.length / elapsedMs) * 100000) / 100,
        ...metrics.summary(),
        resources: {
          nodePeakRssKiB: process.resourceUsage().maxRSS,
          nodeRssAfterBytes: process.memoryUsage().rss,
          cpuUserMs: Math.round(cpu.user / 1000),
          cpuSystemMs: Math.round(cpu.system / 1000),
          eventLoopP95Ms: Math.round(eventLoop.percentile(95) / 10000) / 100,
        },
      });
      if (metrics.stopReason || metrics.summary().unexpectedResponses) break;
    }
    if (suppliedCatalog) {
      phase = "full_catalog_search_bursts";
      const uniqueQueries = [
        ...new Set(
          catalogRows
            .map((row) => row.nameZh.trim().slice(0, 140))
            .filter((q) => q.length >= 2),
        ),
      ].slice(0, 80);
      ensure(
        uniqueQueries.length >= 70,
        "emulator_catalog_search_fixture_too_small",
      );
      const variants = [
        {
          virtualUsers: 20,
          requests: 60,
          queries: ["Kentamin", "咳服", "安離痛"],
          name: "warm_repeated_search_20",
        },
        {
          virtualUsers: 50,
          requests: 100,
          queries: ["Kentamin", "咳服", "安離痛"],
          name: "warm_repeated_search_50",
        },
        {
          virtualUsers: 20,
          requests: 20,
          queries: uniqueQueries.slice(0, 20),
          name: "distinct_uncached_search_20",
        },
        {
          virtualUsers: 50,
          requests: 50,
          queries: uniqueQueries.slice(20, 70),
          name: "distinct_uncached_search_50",
        },
      ];
      for (const variant of variants) {
        const metrics = new LoadMetrics(plan),
          loop = monitorEventLoopDelay({ resolution: 20 });
        loop.enable();
        const began = performance.now(),
          readsBefore = catalogBlobReads;
        await runVirtualUsers(
          variant.virtualUsers,
          variant.requests,
          () => !!metrics.stopReason,
          async (index, iteration) => {
            const user = users[index],
              query =
                variant.queries[
                  (iteration * variant.virtualUsers + index) %
                    variant.queries.length
                ];
            await measuredRequest(metrics, plan.origin, {
              label: "full_catalog_search",
              path: "/drugs/search?q=" + encodeURIComponent(query),
              token: user.token,
              timeoutMs: 30000,
              invariant: (b) => Array.isArray(b.items) && b.items.length <= 12,
            });
          },
        );
        loop.disable();
        const outcome = {
          name: variant.name,
          virtualUsers: variant.virtualUsers,
          distinctQueries: variant.queries.length,
          catalogRows: catalogRows.length,
          elapsedMs: Math.round(performance.now() - began),
          additionalBlobReads: catalogBlobReads - readsBefore,
          eventLoopP95Ms: Math.round(loop.percentile(95) / 10000) / 100,
          ...metrics.summary(),
        };
        controls.push(outcome);
        console.log(
          JSON.stringify({ progress: "catalog_search_burst", ...outcome }),
        );
        ensure(
          !metrics.stopReason && !outcome.unexpectedResponses,
          "emulator_catalog_search_burst_failed",
        );
      }
    }
    phase = "boundary_controls";
    boundaryMetrics = new LoadMetrics({
      ...plan,
      stopP95Ms: 30000,
      stopServerErrorRate: 0.05,
    });
    const boundary = boundaryMetrics;
    const user = users[100];
    const postJob = (
      owner: typeof user,
      key: string,
      question = "Synthetic load fixture question",
      expected = [202],
    ) =>
      measuredRequest(boundary, plan.origin, {
        label: "job_admission",
        path: "/bundles",
        method: "POST",
        token: owner.token,
        body: { medicationIds: [owner.medId], question },
        idempotencyKey: key,
        expected,
        timeoutMs: 30000,
      });
    // All quota writes below are explicit fixtures in the guarded demo project.
    await store.delete("usage", globalKey);
    const key = "synthetic-load-same-" + run;
    const callbackStart = callbackCalls,
      rpcStart = createRpc,
      taskStart = tasks.size;
    const duplicates = await Promise.all(
      Array.from({ length: 100 }, () => postJob(user, key)),
    );
    controls.push({
      name: "duplicate_admission_response_diagnostics",
      statusCounts: Object.fromEntries(
        [...new Set(duplicates.map((r) => r.status))].map((status) => [
          status,
          duplicates.filter((r) => r.status === status).length,
        ]),
      ),
      codeCounts: Object.fromEntries(
        [
          ...new Set(
            duplicates.map((r) =>
              /^[a-z0-9_]{1,80}$/.test(r.data?.code || "")
                ? r.data.code
                : "none",
            ),
          ),
        ].map((code) => [
          code,
          duplicates.filter((r) => (r.data?.code || "none") === code).length,
        ]),
      ),
    });
    ensure(
      duplicates.every((r) => r.status === 202),
      "emulator_duplicate_admission_failed",
    );
    const jobId = duplicates[0].data.jobId;
    ensure(
      new Set(duplicates.map((r) => r.data.jobId)).size === 1,
      "emulator_duplicate_jobs",
    );
    ensure(
      (await store.get("usage", globalKey))?.count === 1 &&
        (await store.get("usage", hash(user.uid + "|" + day)))?.count === 1,
      "emulator_duplicate_quota",
    );
    ensure(tasks.size - taskStart === 1, "emulator_duplicate_tasks");
    controls.push({
      name: "100_identical_http_submissions_two_queue_instances",
      requests: 100,
      uniqueJobs: 1,
      perPersonUsage: 1,
      globalUsage: 1,
      actualTasks: tasks.size - taskStart,
      callbackInvocations: callbackCalls - callbackStart,
      createRpc: createRpc - rpcStart,
    });
    const directStart = createRpc;
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => queues[i % 2].enqueue(jobId)),
    );
    ensure(createRpc - directStart === 2, "emulator_inflight_not_coalesced");
    controls.push({
      name: "100_simultaneous_direct_dispatches_two_instances",
      actualTasksRemainOne: true,
      createRpc: 2,
    });
    const conflict = await postJob(
      user,
      key,
      "Different synthetic question",
      [409],
    );
    ensure(
      conflict.status === 409 &&
        (await store.get("usage", globalKey))?.count === 1,
      "emulator_idempotency_conflict_charge",
    );
    controls.push({
      name: "changed_payload_same_key",
      status: 409,
      additionalQuota: 0,
    });
    const originalTask = dispatchTaskId(jobId, 0, 0);
    tasks.delete(originalTask);
    tombstones.add(originalTask);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => queues[i % 2].enqueue(jobId)),
    );
    ensure(
      (await store.get("jobs", jobId))?.dispatchGeneration === 1 &&
        tasks.has(dispatchTaskId(jobId, 0, 1)),
      "emulator_tombstone_recovery_failed",
    );
    controls.push({
      name: "deleted_task_tombstone_recovery",
      newGeneration: 1,
      additionalQuota: 0,
    });
    await Promise.all(
      Array.from({ length: 30 }, () => domain.processJob(jobId)),
    );
    ensure(
      (await store.get("jobs", jobId))?.attempts === 1 &&
        (await store.get("jobs", jobId))?.status === "succeeded",
      "emulator_concurrent_worker_claim_failed",
    );
    controls.push({
      name: "30_concurrent_worker_deliveries",
      committedAttempts: 1,
      providerCalls: 0,
      result: "missing_synthetic_source_reported_without_generation",
    });
    const usageKey = hash(user.uid + "|" + day);
    await store.set("usage", usageKey, {
      id: usageKey,
      ownerId: user.uid,
      date: day,
      count: 19,
    });
    const personal = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postJob(
          user,
          "synthetic-personal-" + run + "-" + i,
          undefined,
          [202, 429],
        ),
      ),
    );
    ensure(
      personal.filter((r) => r.status === 202).length === 1 &&
        personal.filter((r) => r.status === 429).length === 19 &&
        (await store.get("usage", usageKey))?.count === 20,
      "emulator_personal_boundary_failed",
    );
    controls.push({
      name: "personal_19_to_20_concurrent_boundary",
      submissions: 20,
      admitted: 1,
      quotaRejected: 19,
      finalCount: 20,
    });
    await store.set("usage", globalKey, {
      id: globalKey,
      date: day,
      count: 999,
    });
    const global = await Promise.all(
      users
        .slice(0, 19)
        .map((owner, i) =>
          postJob(
            owner,
            "synthetic-global-" + run + "-" + i,
            undefined,
            [202, 429],
          ),
        ),
    );
    ensure(
      global.filter((r) => r.status === 202).length === 1 &&
        global.filter((r) => r.status === 429).length === 18 &&
        (await store.get("usage", globalKey))?.count === 1000,
      "emulator_global_boundary_failed",
    );
    controls.push({
      name: "global_999_to_1000_concurrent_boundary",
      ordinaryIdentities: 19,
      admitted: 1,
      quotaRejected: 18,
      finalCount: 1000,
    });
    for (const concurrency of [20, 50, 100]) {
      await store.set("usage", globalKey, {
        id: globalKey,
        date: day,
        count: 0,
      });
      const independentOwners = users.slice(0, concurrency);
      const surge = await Promise.all(
        independentOwners.map((owner, i) =>
          postJob(
            owner,
            "synthetic-independent-" + run + "-" + concurrency + "-" + i,
          ),
        ),
      );
      controls.push({
        name: "independent_users_simultaneous_new_jobs",
        ordinaryIdentities: concurrency,
        admitted: surge.filter((r) => r.status === 202).length,
        statusCounts: Object.fromEntries(
          [...new Set(surge.map((r) => r.status))].map((status) => [
            status,
            surge.filter((r) => r.status === status).length,
          ]),
        ),
      });
      ensure(
        surge.every((r) => r.status === 202) &&
          (await store.get("usage", globalKey))?.count === concurrency,
        "emulator_independent_admission_contention_failed",
      );
    }
    phase = "two_domain_admission";
    const secondDomain = new Domain(
      store,
      new FixtureBlobs(),
      domain.llmFactory,
    );
    const secondQueue = new CloudJobQueue(store, transport);
    secondDomain.enqueue = async (id) => {
      callbackCalls++;
      await secondQueue.enqueue(id);
    };
    const secondApp = createApp(secondDomain);
    const secondUrl = new URL(plan.origin);
    secondUrl.port = String(Number(secondUrl.port) + 1);
    const secondOrigin = secondUrl.origin;
    secondServer = serve({
      fetch: secondApp.fetch,
      hostname: "127.0.0.1",
      port: Number(secondUrl.port),
    }) as Server;
    if (!secondServer.listening) await once(secondServer, "listening");
    const warmSecond = await measuredRequest(boundary, secondOrigin, {
      label: "second_instance_warmup",
      path: "/medications",
      token: users[0].token,
      timeoutMs: 30000,
    });
    ensure(warmSecond.status === 200, "emulator_second_instance_warmup_failed");
    await store.set("usage", globalKey, { id: globalKey, date: day, count: 0 });
    const taskCountBefore = tasks.size;
    const twoInstance = await Promise.all(
      users
        .slice(0, 100)
        .map((owner, i) =>
          measuredRequest(boundary, i < 50 ? plan.origin : secondOrigin, {
            label: "two_instance_new_job",
            path: "/bundles",
            method: "POST",
            token: owner.token,
            body: {
              medicationIds: [owner.medId],
              question: "Synthetic two-instance admission",
            },
            idempotencyKey: "synthetic-two-instance-" + run + "-" + i,
            expected: [202],
            timeoutMs: 30000,
          }),
        ),
    );
    controls.push({
      name: "two_domain_shared_firestore_50_plus_50_admission",
      ordinaryIdentities: 100,
      webDomainInstances: 2,
      admitted: twoInstance.filter((r) => r.status === 202).length,
      actualTasksCreated: tasks.size - taskCountBefore,
      statusCounts: Object.fromEntries(
        [...new Set(twoInstance.map((r) => r.status))].map((status) => [
          status,
          twoInstance.filter((r) => r.status === status).length,
        ]),
      ),
    });
    ensure(
      twoInstance.every((r) => r.status === 202) &&
        (await store.get("usage", globalKey))?.count === 100 &&
        tasks.size - taskCountBefore === 100,
      "emulator_two_instance_admission_failed",
    );
    phase = "boundary_controls";
    const faultOwner = users[1],
      faultBefore = (await store.get("usage", globalKey))?.count;
    failCreate = "before";
    const failed = await postJob(
      faultOwner,
      "synthetic-queue-before-" + run,
      undefined,
      [503],
    );
    ensure(
      failed.status === 503 && failed.data?.code === "queue_unavailable",
      "emulator_queue_failure_not_reported",
    );
    const resumed = await postJob(faultOwner, "synthetic-queue-before-" + run);
    ensure(
      resumed.status === 202 &&
        (await store.get("usage", globalKey))?.count === faultBefore + 1,
      "emulator_queue_failure_duplicate_charge",
    );
    controls.push({
      name: "definite_dispatch_failure_same_key_recovery",
      initialStatus: 503,
      resumedStatus: 202,
      quotaCharges: 1,
    });
    const uncertainBefore = (await store.get("usage", globalKey))?.count;
    failCreate = "after";
    const uncertain = await postJob(
      faultOwner,
      "synthetic-queue-after-" + run,
      undefined,
      [503],
    );
    ensure(
      uncertain.status === 503,
      "emulator_uncertain_dispatch_not_reported",
    );
    const reconciled = await postJob(
      faultOwner,
      "synthetic-queue-after-" + run,
    );
    ensure(
      reconciled.status === 202 &&
        (await store.get("usage", globalKey))?.count === uncertainBefore + 1 &&
        !(await store.get("jobs", reconciled.data.jobId))?.dispatchGeneration,
      "emulator_uncertain_dispatch_duplicate_charge",
    );
    controls.push({
      name: "accepted_dispatch_response_lost_same_key_recovery",
      initialStatus: 503,
      resumedStatus: 202,
      quotaCharges: 1,
      generationUnchanged: true,
    });
    const retryId = resumed.data.jobId;
    const retryJob = (await store.get("jobs", retryId))!;
    await store.set("jobs", retryId, {
      ...retryJob,
      status: "failed",
      attempts: 1,
      error: { code: "generation_failed", message: "Synthetic fault" },
    });
    const retryCount = (await store.get("usage", globalKey))?.count;
    const retried = await measuredRequest(boundary, plan.origin, {
      label: "normal_job_retry",
      path: "/jobs/" + retryId + "/retry",
      method: "POST",
      token: faultOwner.token,
      timeoutMs: 30000,
      expected: [202],
    });
    ensure(
      retried.status === 202 &&
        tasks.has(dispatchTaskId(retryId, 1, 0)) &&
        (await store.get("usage", globalKey))?.count === retryCount,
      "emulator_normal_retry_failed",
    );
    controls.push({
      name: "normal_failed_job_retry",
      newAttemptTaskIdentity: true,
      additionalQuota: 0,
    });
    const expiredId = reconciled.data.jobId,
      expiredJob = (await store.get("jobs", expiredId))!;
    await store.set("jobs", expiredId, {
      ...expiredJob,
      status: "running",
      attempts: 1,
      leaseUntil: Date.now() - 1000,
    });
    await queues[0].enqueue(expiredId);
    ensure(
      tasks.has(dispatchTaskId(expiredId, 1, 0)),
      "emulator_expired_worker_not_dispatched",
    );
    await Promise.all(
      Array.from({ length: 20 }, () => domain.processJob(expiredId)),
    );
    ensure(
      (await store.get("jobs", expiredId))?.status === "succeeded" &&
        (await store.get("jobs", expiredId))?.attempts === 2,
      "emulator_expired_worker_claim_failed",
    );
    controls.push({
      name: "expired_worker_recovery",
      committedAttempt: 2,
      overlappingDeliveries: 20,
      additionalQuota: 0,
    });
    const quiz = users[1];
    const answers = await Promise.all(
      ["synthetic-q1", "synthetic-q2"].map((id, index) =>
        measuredRequest(boundary, plan.origin, {
          label: "concurrent_quiz_answers",
          path: "/learning/" + quiz.learningId + "/answers",
          method: "POST",
          token: quiz.token,
          body: { answers: { [id]: index } },
          timeoutMs: 30000,
        }),
      ),
    );
    const learned = await store.get("learning", quiz.learningId);
    ensure(
      answers.every((r) => r.status === 200) &&
        learned?.answers?.["synthetic-q1"] === 0 &&
        learned?.answers?.["synthetic-q2"] === 1 &&
        learned?.passed,
      "emulator_concurrent_answers_lost",
    );
    controls.push({
      name: "concurrent_quiz_answer_merge",
      questionsRetained: 2,
      passed: true,
    });
    phase = "photo_concurrency";
    const photo = await (
      await import("./load-photo.js")
    ).runPhotoLoad({
      plan,
      users,
      store,
      imageBlobs,
      globalUsageKey: globalKey,
      run,
    });
    controls.push({ name: "photo_upload_concurrency", ...photo });
    phase = "auth_and_account_controls";
    const accountUser = users[5],
      originalAccount = (await store.get("users", accountUser.uid))!;
    await store.set("users", accountUser.uid, {
      ...originalAccount,
      disabled: true,
    });
    const disabled = await measuredRequest(boundary, plan.origin, {
      label: "disabled_account_existing_session",
      path: "/me",
      token: accountUser.token,
      expected: [403],
      timeoutMs: 30000,
    });
    const disabledWrite = await measuredRequest(boundary, plan.origin, {
      label: "disabled_account_write",
      path: "/medications",
      method: "POST",
      token: accountUser.token,
      body: medInput,
      expected: [403],
      timeoutMs: 30000,
    });
    ensure(
      disabled.status === 403 && disabledWrite.status === 403,
      "emulator_disabled_account_accepted",
    );
    await store.set("users", accountUser.uid, {
      ...originalAccount,
      deleting: true,
    });
    const deleting = await measuredRequest(boundary, plan.origin, {
      label: "deleting_account_existing_session",
      path: "/me",
      token: accountUser.token,
      expected: [403],
      timeoutMs: 30000,
    });
    ensure(deleting.status === 403, "emulator_deleting_account_accepted");
    await store.set("users", accountUser.uid, originalAccount);
    controls.push({
      name: "disabled_and_deleting_application_account",
      existingSessionReadRejected: true,
      writeRejected: true,
      syntheticFixtureRestored: true,
    });
    const unverifiedUser = users[7];
    await auth.updateUser(unverifiedUser.uid, { emailVerified: false });
    const unverifiedToken = await signIn(
      unverifiedUser.uid + "@example.invalid",
    );
    const beforeUnverified = (await store.get("usage", globalKey))?.count;
    const unverified = await measuredRequest(boundary, plan.origin, {
      label: "unverified_account_ai_denied",
      path: "/bundles",
      method: "POST",
      token: unverifiedToken,
      body: {
        medicationIds: [unverifiedUser.medId],
        question: "Synthetic denied request",
      },
      idempotencyKey: "synthetic-unverified-" + run,
      expected: [403],
      timeoutMs: 30000,
    });
    ensure(
      unverified.status === 403 &&
        unverified.data?.code === "email_unverified" &&
        (await store.get("usage", globalKey))?.count === beforeUnverified,
      "emulator_unverified_account_consumed_quota",
    );
    await auth.updateUser(unverifiedUser.uid, { emailVerified: true });
    controls.push({
      name: "actual_unverified_emulator_id_token",
      status: 403,
      quotaCharges: 0,
    });
    const authDisabledUser = users[9];
    await auth.updateUser(authDisabledUser.uid, { disabled: true });
    const revoked = await measuredRequest(boundary, plan.origin, {
      label: "auth_disabled_existing_id_token",
      path: "/me",
      token: authDisabledUser.token,
      expected: [401],
      timeoutMs: 30000,
    });
    ensure(revoked.status === 401, "emulator_auth_disabled_token_accepted");
    await auth.updateUser(authDisabledUser.uid, { disabled: false });
    controls.push({
      name: "firebase_auth_disabled_existing_token",
      status: 401,
      checkRevokedVerified: true,
    });
    const preservedJobs = await store.list("jobs", ["ownerId", user.uid]);
    phase = "http_restart";
    await stop();
    const restored = new Domain(
      new FirestoreStore(),
      new FixtureBlobs(),
      domain.llmFactory,
    );
    restored.enqueue = domain.enqueue;
    app = createApp(restored);
    await start();
    const restartMetrics = new LoadMetrics(plan);
    const restoredSession = await measuredRequest(restartMetrics, plan.origin, {
      label: "restart_session",
      path: "/me",
      token: user.token,
      timeoutMs: 30000,
      invariant: (b) => b.account?.id === user.uid,
    });
    const restoredJob = await measuredRequest(restartMetrics, plan.origin, {
      label: "restart_job",
      path: "/jobs/" + jobId,
      token: user.token,
      timeoutMs: 30000,
      invariant: (b) => b.status === "succeeded" && b.ownerId === user.uid,
    });
    ensure(
      restoredSession.expected &&
        restoredJob.expected &&
        (await store.list("jobs", ["ownerId", user.uid])).length ===
          preservedJobs.length,
      "emulator_restart_failed",
    );
    controls.push({
      name: "application_http_restart",
      sameFirebaseTokenAccepted: true,
      persistedJobReadable: true,
      additionalJobs: 0,
    });
    ensure(fakeProviderCalls === 0, "emulator_unexpected_provider_call");
    ensure(
      (await store.get("settings", "testerSeats"))?.uids.length === 50,
      "emulator_legacy_registry_changed",
    );
    return {
      scenario: "isolated_official_auth_and_firestore_adapters_real_http",
      synthetic: true,
      distinctSyntheticOrdinaryIdentities: users.length,
      authVerifier: "shipped_firebase_admin_verifyIdToken_checkRevoked",
      store: "FirestoreStore_against_official_emulator",
      catalog: {
        actualPublicCatalogRows: catalogRows.length,
        sourceSha256: suppliedCatalog
          ? createHash("sha256").update(suppliedCatalog).digest("hex")
          : null,
        syntheticRowsAdded: 1,
        source: "in_memory_readback_blob",
        blobReads: catalogBlobReads,
      },
      providerCalls: fakeProviderCalls,
      externalAccountsCreated: 0,
      externalApplicationWrites: 0,
      realQuotaResets: 0,
      configuredLimits: { dailyPerPerson: 20, dailySiteWide: 1000 },
      seededHistoryRecordsPerIdentity: 10,
      profiles,
      controls,
      boundaryRequests: boundaryMetrics.summary(),
      normalizedServerLogCounts: errors,
      limitations: [
        "Emulators reproduce API and transaction behavior, not production latency, quotas, scaling, indexes, contention semantics, native AI quality or provider throughput.",
        "History and source content are explicitly synthetic; no clinical content accuracy is evaluated.",
        "The public catalog is a local byte-pinned readback plus one synthetic medication; object-network latency is excluded.",
      ],
    };
  } catch (error) {
    const reason =
      error instanceof Error &&
      /^(?:emulator_|unexpected_blob_|blob_)[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "emulator_execution_failed";
    return {
      scenario: "isolated_official_adapters_real_http",
      profiles,
      controls,
      boundaryRequests: boundaryMetrics?.summary(),
      invariantFailure: {
        phase,
        reason,
        sdkCode:
          typeof (error as any)?.code === "number" ? (error as any).code : null,
      },
      normalizedServerLogCounts: errors,
      providerCalls: fakeProviderCalls,
      externalApplicationWrites: 0,
    };
  } finally {
    console.error = originalError;
    await stop().catch(() => {});
    if (secondServer)
      await new Promise<void>((resolve) =>
        secondServer!.close(() => resolve()),
      );
    await store.db.terminate().catch(() => {});
    await deleteApp(firebaseApp()).catch(() => {});
  }
}
