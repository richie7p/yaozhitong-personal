import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../server/store.js";
import { LoadMetrics, measuredRequest, type LoadPlan } from "./load-core.js";

/** Generated noisy JPEG bytes exercise decode/storage boundaries, not OCR quality. */
export async function runPhotoLoad(context: {
  plan: LoadPlan;
  users: { uid: string; token: string }[];
  store: Store;
  imageBlobs: Map<string, Buffer>;
  globalUsageKey: string;
  run: string;
}) {
  const { default: sharp } = await import("sharp");
  const { plan, users, store, imageBlobs } = context;
  const pixels = randomBytes(1536 * 1536 * 3);
  const jpeg = await sharp(pixels, {
    raw: { width: 1536, height: 1536, channels: 3 },
  })
    .jpeg({ quality: 82 })
    .toBuffer();
  if (jpeg.length < 1_000_000 || jpeg.length > 2_000_000)
    throw Error("emulator_photo_fixture_size_out_of_bounds");
  const image = jpeg.toString("base64");
  const digest = (data: string | Buffer) =>
    createHash("sha256").update(data).digest("hex");
  const byteDigest = digest(jpeg),
    imageHash = digest(image);
  const phases = [];
  for (const concurrency of [5, 10, 20]) {
    const metrics = new LoadMetrics({ ...plan, stopP95Ms: 30000 });
    const started = performance.now(),
      beforeUsage =
        (await store.get("usage", context.globalUsageKey))?.count || 0;
    const beforeBlobCount = imageBlobs.size;
    const memoryBefore = process.memoryUsage().rss;
    let maximumRss = memoryBefore;
    const sampler = setInterval(() => {
      maximumRss = Math.max(maximumRss, process.memoryUsage().rss);
    }, 10);
    const rows = users
      .slice(0, concurrency)
      .map((user, index) => ({
        user,
        index,
        key: "synthetic-photo-" + context.run + "-" + concurrency + "-" + index,
        jobId: "",
        posts: 0,
      }));
    let retries = 0,
      busyResponses = 0,
      initialBusyResponses = 0,
      serverBusyResponses = 0;
    try {
      for (
        let round = 0;
        round < 12 && rows.some((row) => !row.jobId);
        round++
      ) {
        if (performance.now() - started > 20000)
          throw Error("emulator_photo_recovery_deadline");
        await Promise.all(
          rows
            .filter((row) => !row.jobId)
            .map(async (row, pendingIndex) => {
              if (round) {
                retries++;
                await new Promise((resolve) =>
                  setTimeout(resolve, 250 + pendingIndex * 70),
                );
              }
              row.posts++;
              const response = await measuredRequest(metrics, plan.origin, {
                label: round
                  ? "photo_same_key_recovery"
                  : "photo_initial_concurrent_upload",
                path: "/recognitions",
                method: "POST",
                token: row.user.token,
                body: { image, mediaType: "image/jpeg" },
                idempotencyKey: row.key,
                timeoutMs: 30000,
                expected: [202, 429, 503],
              });
              if (
                response.status === 429 &&
                response.data?.code === "image_busy"
              ) {
                busyResponses++;
                if (!round) initialBusyResponses++;
                return;
              }
              if (
                response.status === 503 &&
                ["service_busy", "queue_unavailable"].includes(
                  response.data?.code,
                )
              ) {
                serverBusyResponses++;
                return;
              }
              if (response.status !== 202 || !response.data?.jobId)
                throw Error("emulator_photo_unexpected_response");
              row.jobId = response.data.jobId;
              const job = await store.get("jobs", row.jobId);
              const blob = job?.input?.imagePath
                ? imageBlobs.get(job.input.imagePath)
                : undefined;
              if (
                job?.ownerId !== row.user.uid ||
                job.kind !== "recognition" ||
                job.input.imageHash !== imageHash ||
                !String(job.input.imagePath).startsWith(
                  "uploads/" + row.user.uid + "/",
                ) ||
                !blob ||
                digest(blob) !== byteDigest
              )
                throw Error("emulator_photo_owner_or_bytes_mismatch");
            }),
        );
      }
      if (rows.some((row) => !row.jobId))
        throw Error("emulator_photo_recovery_incomplete");
      const first = rows[0];
      const repeated = await measuredRequest(metrics, plan.origin, {
        label: "photo_repeat_accepted_operation",
        path: "/recognitions",
        method: "POST",
        token: first.user.token,
        body: { image, mediaType: "image/jpeg" },
        idempotencyKey: first.key,
        timeoutMs: 30000,
        expected: [202],
      });
      if (
        repeated.data?.jobId !== first.jobId ||
        imageBlobs.size - beforeBlobCount !== concurrency ||
        (await store.get("usage", context.globalUsageKey))?.count !==
          beforeUsage + concurrency
      )
        throw Error("emulator_photo_duplicate_or_quota_charge");
      const hidden = await measuredRequest(metrics, plan.origin, {
        label: "photo_cross_owner_read",
        path: "/jobs/" + first.jobId,
        token: rows[1].user.token,
        timeoutMs: 30000,
        expected: [404],
      });
      if (hidden.status !== 404) throw Error("emulator_photo_cross_owner_leak");
      const changed = await measuredRequest(metrics, plan.origin, {
        label: "photo_changed_input_same_key",
        path: "/recognitions",
        method: "POST",
        token: first.user.token,
        body: {
          image: image.slice(0, -8) + "AAAAAA==",
          mediaType: "image/jpeg",
        },
        idempotencyKey: first.key,
        timeoutMs: 30000,
        expected: [409],
      });
      if (
        changed.status !== 409 ||
        imageBlobs.size - beforeBlobCount !== concurrency ||
        (await store.get("usage", context.globalUsageKey))?.count !==
          beforeUsage + concurrency
      )
        throw Error("emulator_photo_conflict_changed_state");
      phases.push({
        virtualUsers: concurrency,
        jpegBytesPerUpload: jpeg.length,
        allDistinctUsersEventuallyAccepted: true,
        initialBusyResponses,
        totalImageBusyResponses: busyResponses,
        serverBusyResponses,
        sameKeyRecoveryRequests: retries,
        logicalJobsCreated: concurrency,
        quotaCharges: concurrency,
        exactOriginalBytesRetained: true,
        extraBlobsFromResends: 0,
        crossOwnerStatus: 404,
        changedInputStatus: 409,
        durationMs: Math.round(performance.now() - started),
        driverAndServerSameProcess: true,
        rssBeforeBytes: memoryBefore,
        sampledPeakRssBytes: maximumRss,
        ...metrics.summary(),
      });
      console.log(
        JSON.stringify({
          progress: "photo_concurrency",
          virtualUsers: concurrency,
          logicalJobs: concurrency,
          jpegBytes: jpeg.length,
          imageBusyResponses: busyResponses,
          serverBusyResponses,
          retries,
          p95Ms: metrics.summary().p95Ms,
        }),
      );
    } finally {
      clearInterval(sampler);
    }
  }
  return {
    fixture: "synthetic_noise_jpeg_not_a_drug_photo",
    fixtureSha256: byteDigest,
    width: 1536,
    height: 1536,
    providerCalls: 0,
    storage: "isolated_in_memory_blob_adapter",
    phases,
    limitations: [
      "This verifies upload validation, owner boundaries, idempotency, queued persistence and recovery. It does not run paid vision or assess recognition accuracy.",
      "RSS includes the load driver and test fixtures in the same process; it is not a standalone production server memory measurement.",
    ],
  };
}
