import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";
import type { Account, Identity, Job, JobKind } from "../shared/schema.js";
import { config, AppError, fail } from "./config.js";
import { authenticate, localPeople, localToken, verifyWorker } from "./auth.js";
import { Domain, hash, now } from "./domain.js";
import { extractLeaflet } from "./leaflets.js";
import { tick } from "./scheduler.js";
import { refreshCatalog } from "./import-catalog.js";
type Env = {
  Variables: { identity: Identity; account: Account; requestId: string };
};
export function createApp(d: Domain, auth = authenticate) {
  const app = new Hono<Env>();
  app.use(
    "*",
    secureHeaders({ crossOriginOpenerPolicy: "same-origin-allow-popups" }),
  );
  app.use("*", async (c, next) => {
    c.set("requestId", randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 20_000_000,
      onError: (c) =>
        c.json(
          {
            code: "payload_too_large",
            message: "上傳檔案太大。",
            requestId: c.get("requestId"),
          },
          413,
        ),
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/v1/config", (c) =>
    c.json({
      mode: config.mode,
      firebase: JSON.parse(process.env.FIREBASE_WEB_CONFIG || "{}"),
      vapidKey: process.env.FIREBASE_VAPID_KEY || "",
      ai: !!config.nvidiaKey,
      localAccounts: config.mode === "local" ? localPeople : [],
      appVersion: "0.1.0",
    }),
  );
  app.post("/api/v1/auth/local", async (c) => {
    if (config.mode !== "local") return fail("not_found", "沒有此端點。", 404);
    const b = z.object({ uid: z.string() }).parse(await c.req.json());
    return c.json({ token: localToken(b.uid) });
  });
  app.post("/internal/jobs/:id", async (c) => {
    await verifyWorker(
      c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    );
    await d.processJob(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/internal/tick", async (c) => {
    await verifyWorker(
      c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    );
    return c.json(await tick(d));
  });
  app.post("/internal/catalog", async (c) => {
    await verifyWorker(
      c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    );
    const result = await refreshCatalog(d.store, d.blobs);
    d.catalog.invalidate();
    return c.json(result);
  });
  app.use("/api/v1/*", async (c, next) => {
    if (config.role === "worker") return fail("not_found", "沒有此端點。", 404);
    const id = await auth(
      c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    );
    const account = await d.account(id);
    c.set("identity", id);
    c.set("account", account);
    await next();
  });
  const uid = (c: any) => c.get("identity").uid as string;
  app.get("/api/v1/me", async (c) => c.json(await d.me(uid(c))));
  app.put("/api/v1/me", async (c) =>
    c.json(await d.profile(uid(c), await c.req.json())),
  );
  app.get("/api/v1/me/export", async (c) => {
    c.header(
      "Content-Disposition",
      'attachment; filename="yaozhitong-export.json"',
    );
    return c.json(await d.exportUser(uid(c)));
  });
  app.delete("/api/v1/me", async (c) =>
    c.json(await d.deleteAccount(uid(c)), 202),
  );
  app.get("/api/v1/medications", async (c) =>
    c.json({
      items: await d.medications(uid(c)),
      duplicates: await d.duplicates(uid(c)),
    }),
  );
  app.post("/api/v1/medications", async (c) =>
    c.json(await d.saveMedication(uid(c), await c.req.json()), 201),
  );
  app.put("/api/v1/medications/:id", async (c) =>
    c.json(
      await d.saveMedication(uid(c), await c.req.json(), c.req.param("id")),
    ),
  );
  app.delete("/api/v1/medications/:id", async (c) => {
    await d.removeMedication(uid(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/v1/drugs/search", async (c) =>
    c.json({ items: await d.search((c.req.query("q") || "").slice(0, 150)) }),
  );
  app.get("/api/v1/schedules", async (c) =>
    c.json({ items: await d.store.list("schedules", ["ownerId", uid(c)]) }),
  );
  app.post("/api/v1/schedules", async (c) =>
    c.json(await d.saveSchedule(uid(c), await c.req.json()), 201),
  );
  app.get("/api/v1/today", async (c) =>
    c.json({ items: await d.today(uid(c)) }),
  );
  app.get("/api/v1/dose-logs", async (c) =>
    c.json({
      items: (await d.store.list("doseLogs", ["ownerId", uid(c)])).sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      ),
    }),
  );
  app.post("/api/v1/dose-logs", async (c) =>
    c.json(await d.doseLog(uid(c), await c.req.json())),
  );
  app.patch("/api/v1/dose-logs/:id", async (c) => {
    const b = z
      .object({
        status: z.enum(["taken", "skipped"]),
        note: z.string().max(300).default(""),
      })
      .parse(await c.req.json());
    const id = c.req.param("id");
    const result = await d.store.transaction(async (tx) => {
      const old = await tx.get("doseLogs", id);
      if (!old || old.ownerId !== uid(c))
        return fail("not_found", "找不到紀錄。", 404);
      const correctionId = randomUUID();
      const updated = {
        ...old,
        ...b,
        updatedAt: now(),
        revision: (old.revision || 0) + 1,
      };
      tx.set("doseLogs", id, updated);
      tx.set("doseCorrections", correctionId, {
        id: correctionId,
        ownerId: uid(c),
        logId: id,
        previous: old.status,
        status: b.status,
        at: now(),
      });
      return updated;
    });
    return c.json(result);
  });
  app.get("/api/v1/cabinet", async (c) =>
    c.json({ items: await d.store.list("cabinet", ["ownerId", uid(c)]) }),
  );
  app.post("/api/v1/cabinet", async (c) =>
    c.json(await d.saveCabinet(uid(c), await c.req.json()), 201),
  );
  app.put("/api/v1/cabinet/:id", async (c) =>
    c.json(await d.saveCabinet(uid(c), await c.req.json(), c.req.param("id"))),
  );
  app.get("/api/v1/care", async (c) =>
    c.json({ items: await d.relationships(uid(c)) }),
  );
  app.post("/api/v1/care/invites", async (c) =>
    c.json(await d.invite(uid(c), c.get("identity").verified), 201),
  );
  app.post("/api/v1/care/accept", async (c) => {
    const b = z
      .object({ code: z.string().min(1).max(40) })
      .parse(await c.req.json());
    return c.json(await d.accept(uid(c), b.code, c.get("identity").verified));
  });
  app.delete("/api/v1/care/:id", async (c) => {
    await d.revoke(uid(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/v1/care/:id/snapshot", async (c) =>
    c.json(await d.snapshot(uid(c), c.req.param("id"))),
  );
  app.post("/api/v1/devices", async (c) => {
    const b = z
      .object({ token: z.string().min(20).max(4000) })
      .parse(await c.req.json());
    const id = hash(b.token);
    const old = await d.store.get("devices", id);
    if (old && old.ownerId !== uid(c)) await d.store.delete("devices", id);
    await d.store.set("devices", id, {
      id,
      ownerId: uid(c),
      token: b.token,
      updatedAt: now(),
    });
    return c.json({ id });
  });
  app.delete("/api/v1/devices/:id", async (c) => {
    await d.owned("devices", c.req.param("id"), uid(c));
    await d.store.delete("devices", c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/v1/notifications", async (c) =>
    c.json({ items: await d.store.list("notifications", ["ownerId", uid(c)]) }),
  );
  app.post("/api/v1/recognitions", async (c) => {
    const b = z
      .object({
        image: z.string().max(11_000_000),
        mediaType: z.enum(["image/jpeg", "image/png"]),
      })
      .parse(await c.req.json());
    const data = Buffer.from(b.image, "base64");
    if (
      data.length > 8_000_000 ||
      !(b.mediaType === "image/png"
        ? data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : data[0] === 255 && data[1] === 216)
    )
      return fail("invalid_image", "請上傳 8 MB 以內的 JPEG 或 PNG 圖片。");
    const imagePath = `uploads/${uid(c)}/${randomUUID()}`;
    await d.blobs.put(imagePath, data, b.mediaType);
    try {
      const j = await d.enqueueJob(
        uid(c),
        c.get("identity").verified,
        "recognition",
        { imagePath, mediaType: b.mediaType, imageHash: hash(b.image) },
        c.req.header("Idempotency-Key") || "",
      );
      if (j.input.imagePath !== imagePath) await d.blobs.delete(imagePath);
      return c.json({ jobId: j.id, status: j.status }, 202);
    } catch (e) {
      const jobId = hash(
        uid(c) + "|recognition|" + (c.req.header("Idempotency-Key") || ""),
      );
      const existing = await d.store.get<Job>("jobs", jobId);
      if (existing?.input.imagePath !== imagePath)
        await d.blobs.delete(imagePath);
      throw e;
    }
  });
  for (const [route, kind] of [
    ["chat", "chat"],
    ["bundles", "bundle"],
    ["interactions", "interaction"],
  ] as const)
    app.post("/api/v1/" + route, async (c) => {
      const b = z
        .object({
          medicationIds: z
            .array(z.string().min(1).max(80))
            .min(1)
            .max(kind === "interaction" ? 2 : 8),
          question: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .default(
              kind === "interaction"
                ? "請比對這兩款藥的仿單交互作用記載。"
                : "請整理仿單白話說明、警語、追問與理解測驗。",
            ),
        })
        .parse(await c.req.json());
      if (
        kind === "interaction" &&
        (b.medicationIds.length !== 2 || new Set(b.medicationIds).size !== 2)
      )
        return fail("invalid_request", "請選擇兩款不同藥品。");
      for (const id of b.medicationIds)
        await d.owned("medications", id, uid(c));
      const j = await d.enqueueJob(
        uid(c),
        c.get("identity").verified,
        kind,
        b,
        c.req.header("Idempotency-Key") || "",
      );
      return c.json({ jobId: j.id, status: j.status }, 202);
    });
  app.get("/api/v1/jobs/:id", async (c) => {
    const j = await d.owned<Job>("jobs", c.req.param("id"), uid(c));
    const { input, ...publicJob } = j;
    return c.json(publicJob);
  });
  app.get("/api/v1/jobs", async (c) =>
    c.json({
      items: (await d.store.list<Job>("jobs", ["ownerId", uid(c)]))
        .filter((j) => j.kind !== "delete-account")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100)
        .map(({ input, ...j }) => j),
    }),
  );
  app.post("/api/v1/jobs/:id/retry", async (c) => {
    if (!c.get("identity").verified || !c.get("account").eligible)
      return fail("forbidden", "需要驗證信箱及測試資格。", 403);
    return c.json(await d.retryJob(uid(c), c.req.param("id")), 202);
  });
  app.get("/api/v1/chat", async (c) =>
    c.json({ items: await d.store.list("chats", ["ownerId", uid(c)]) }),
  );
  app.get("/api/v1/learning", async (c) => {
    const items = await d.store.list("learning", ["ownerId", uid(c)]);
    const valid = await Promise.all(
      items.map((x) => d.learningCurrent(uid(c), x)),
    );
    return c.json({
      items: items.filter((_, i) => valid[i]),
    });
  });
  app.post("/api/v1/learning/:id/answers", async (c) => {
    const row = await d.owned<any>("learning", c.req.param("id"), uid(c));
    if (!(await d.learningCurrent(uid(c), row)))
      return fail(
        "stale_content",
        "仿單或個人資料已更新，請重新產生測驗。",
        409,
      );
    const b = z
      .object({ answers: z.record(z.string(), z.number().int().nonnegative()) })
      .parse(await c.req.json());
    const quiz = row.result.quiz;
    const results = quiz.map((q: any) => ({
      id: q.id,
      correct: b.answers[q.id] === q.answer,
      answer: q.answer,
      explain: q.explain,
    }));
    await d.store.set("learning", row.id, {
      ...row,
      answers: b.answers,
      passed: quiz.length > 0 && results.every((x: any) => x.correct),
    });
    return c.json({ results });
  });
  app.use("/api/v1/admin/*", async (c, next) => {
    if (!c.get("identity").admin)
      return fail("forbidden", "需要管理員權限。", 403);
    await next();
  });
  app.get("/api/v1/admin/users", async (c) => {
    const q = (c.req.query("q") || "").toLowerCase();
    return c.json({
      items: (await d.store.list<Account>("users"))
        .filter((u) =>
          (u.email + " " + u.displayName).toLowerCase().includes(q),
        )
        .map(({ id, email, displayName, eligible, disabled, admin }) => ({
          id,
          email,
          displayName,
          eligible,
          disabled,
          admin,
        })),
    });
  });
  app.patch("/api/v1/admin/users/:id", async (c) => {
    const b = z
      .object({
        disabled: z.boolean().optional(),
        eligible: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    await d.setUser(uid(c), c.req.param("id"), b);
    return c.json({ ok: true });
  });
  app.get("/api/v1/admin/leaflets", async (c) =>
    c.json({ items: await d.store.list("leaflets") }),
  );
  app.post("/api/v1/admin/leaflets", async (c) => {
    const b = z
      .object({
        licenseNo: z.string().min(1).max(80),
        sourceUrl: z.string().url(),
        pdf: z.string().max(20_000_000),
      })
      .parse(await c.req.json());
    const bytes = Buffer.from(b.pdf, "base64");
    const leaflet = await extractLeaflet(bytes, b.licenseNo, b.sourceUrl);
    await d.blobs.put(leaflet.storagePath, bytes, "application/pdf");
    await d.store.set("leaflets", leaflet.id, leaflet);
    await d.audit(uid(c), "leaflet.upload", leaflet.id);
    return c.json(leaflet, 201);
  });
  app.put("/api/v1/admin/leaflets/:id/text", async (c) => {
    const b = z
      .object({
        pages: z
          .array(
            z.object({
              page: z.number().int().positive(),
              text: z.string().min(8).max(40000),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(await c.req.json());
    const l = await d.store.get("leaflets", c.req.param("id"));
    if (!l || l.status !== "draft")
      return fail("invalid_leaflet", "只能編輯草稿。");
    const version = hash(l.sha256 + JSON.stringify(b.pages)).slice(0, 16);
    const chunks = b.pages.flatMap((p) => {
      const rows = [];
      for (let start = 0; start < p.text.length; start += 1000)
        rows.push({
          id: `${l.id.slice(0, 16)}-${version}-${p.page}-${start}`,
          licenseNo: l.licenseNo,
          version,
          page: p.page,
          start,
          text: p.text.slice(start, start + 1000),
        });
      return rows;
    });
    if (Buffer.byteLength(JSON.stringify(chunks)) > 800000)
      return fail("leaflet_too_large", "文字太長。");
    await d.store.set("leaflets", l.id, { ...l, chunks, version });
    await d.audit(uid(c), "leaflet.edit", l.id);
    return c.json({ ok: true });
  });
  app.post("/api/v1/admin/leaflets/:id/publish", async (c) => {
    const b = z.object({ reviewed: z.literal(true) }).parse(await c.req.json());
    await d.publish(uid(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/v1/admin/usage", async (c) =>
    c.json({
      items: await d.store.list("usage"),
      jobs: (await d.store.list<Job>("jobs")).map(
        ({
          id,
          kind,
          status,
          error,
          createdAt,
          attempts,
          tokens,
          latencyMs,
        }) => ({
          id,
          kind,
          status,
          errorCode: error?.code,
          createdAt,
          attempts,
          tokens: tokens ?? 0,
          latencyMs: latencyMs ?? null,
        }),
      ),
      catalog: await d.store.get("settings", "catalog"),
    }),
  );
  app.post("/api/v1/admin/jobs/:id/retry", async (c) => {
    const j = await d.store.get<Job>("jobs", c.req.param("id"));
    if (!j) return fail("not_found", "找不到任務。", 404);
    if (j.kind !== "delete-account") await d.active(j.ownerId);
    const result = await d.retryJob(j.ownerId, j.id);
    await d.audit(uid(c), "job.retry", j.id);
    return c.json(result, 202);
  });
  app.get("/api/v1/admin/audit", async (c) =>
    c.json({ items: await d.store.list("audit") }),
  );
  app.put("/api/v1/admin/ingredient-aliases", async (c) => {
    const b = z
      .record(z.string().max(100), z.string().max(100))
      .parse(await c.req.json());
    await d.store.set("settings", "ingredientAliases", b);
    await d.audit(uid(c), "ingredients.update", "aliases");
    return c.json({ ok: true });
  });
  app.onError((e, c) => {
    const error =
      e instanceof ZodError
        ? new AppError(
            "invalid_request",
            e.issues[0]?.message || "輸入格式不正確。",
          )
        : e instanceof SyntaxError
          ? new AppError("invalid_request", "JSON 格式不正確。", 400)
          : e instanceof AppError
            ? e
            : new AppError("internal_error", "服務暫時無法完成請求。", 500);
    console.error(
      JSON.stringify({
        requestId: c.get("requestId"),
        code: error.code,
        status: error.status,
        causeCode:
          e instanceof AppError || e instanceof ZodError
            ? undefined
            : (e as NodeJS.ErrnoException).code,
      }),
    );
    return c.json(
      {
        code: error.code,
        message: error.message,
        requestId: c.get("requestId"),
      },
      error.status as any,
    );
  });
  app.notFound((c) =>
    c.json(
      {
        code: "not_found",
        message: "找不到此功能。",
        requestId: c.get("requestId"),
      },
      404,
    ),
  );
  return app;
}
