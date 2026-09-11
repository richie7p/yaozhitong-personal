import { createHash, randomUUID, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { getAuth } from "firebase-admin/auth";
import {
  ProfileSchema,
  MedicationSchema,
  ScheduleSchema,
  CabinetSchema,
  type Account,
  type Identity,
  type Medication,
  type Schedule,
  type Job,
  type JobKind,
  type Leaflet,
  type GroundedResult,
} from "../shared/schema.js";
import { config, fail, AppError } from "./config.js";
import { firebaseApp, type Store, type Doc } from "./store.js";
import { Blobs } from "./blobs.js";
import { Catalog } from "./catalog.js";
import {
  grounded,
  recognize,
  Nvidia,
  GROUNDING_VERSION,
  type Llm,
} from "./ai.js";
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const now = () => new Date().toISOString();
export function nextTime(
  s: Pick<Schedule, "startDate" | "endDate" | "times" | "timezone">,
  after: string,
): string | null {
  const t = DateTime.fromISO(after, { zone: s.timezone });
  const start = DateTime.fromISO(s.startDate, { zone: s.timezone });
  if (!start.isValid || (s.endDate && !DateTime.fromISO(s.endDate).isValid))
    return fail("invalid_date", "日期無效。");
  let day = t.startOf("day") < start ? start : t.startOf("day");
  for (let i = 0; i < 3; i++, day = day.plus({ days: 1 })) {
    if (s.endDate && day.toISODate()! > s.endDate) return null;
    for (const clock of s.times) {
      const [hour, minute] = clock.split(":").map(Number);
      const at = day.set({ hour, minute });
      if (at > t) return at.toUTC().toISO();
    }
  }
  return null;
}
export class Domain {
  catalog: Catalog;
  enqueue: ((id: string) => Promise<void>) | null = null;
  constructor(
    public store: Store,
    public blobs = new Blobs(),
    public llmFactory: () => Llm = () => new Nvidia(),
  ) {
    this.catalog = new Catalog(store, blobs);
  }
  async account(identity: Identity) {
    return this.store.transaction(async (tx) => {
      let u = await tx.get<Account>("users", identity.uid);
      if (u?.disabled || u?.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      if (!u) {
        u = {
          id: identity.uid,
          email: identity.email,
          displayName: identity.name,
          admin: identity.admin,
          eligible: config.mode === "local",
          disabled: false,
          deleting: false,
          profileVersion: 0,
          createdAt: now(),
        };
        tx.set("users", u.id, u);
      }
      if (u.admin !== identity.admin || u.email !== identity.email) {
        u = { ...u, admin: identity.admin, email: identity.email };
        tx.set("users", u.id, u);
      }
      return u;
    });
  }
  async active(uid: string) {
    const u = await this.store.get<Account>("users", uid);
    if (!u || u.disabled || u.deleting)
      return fail("account_disabled", "帳號已停用。", 403);
    return u;
  }
  async writePrivate(uid: string, collection: string, id: string, value: Doc) {
    await this.store.transaction(async (tx) => {
      const u = await tx.get<Account>("users", uid);
      if (!u || u.disabled || u.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      tx.set(collection, id, value);
    });
  }
  async owned<T extends { ownerId: string }>(
    collection: string,
    id: string,
    uid: string,
  ): Promise<T> {
    const r = await this.store.get<T>(collection, id);
    if (!r || r.ownerId !== uid) return fail("not_found", "找不到資料。", 404);
    return r;
  }
  async me(uid: string) {
    return {
      account: await this.active(uid),
      profile: await this.store.get("profiles", uid),
    };
  }
  async profile(uid: string, data: unknown) {
    const p = ProfileSchema.parse(data);
    await this.store.transaction(async (tx) => {
      const u = await tx.get<Account>("users", uid);
      if (!u || u.disabled || u.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      tx.set("profiles", uid, { ...p, id: uid, ownerId: uid });
      tx.set("users", uid, {
        ...u,
        displayName: p.displayName,
        profileVersion: u.profileVersion + 1,
      });
    });
    return p;
  }
  async medications(uid: string) {
    return (
      await this.store.list<Medication>("medications", ["ownerId", uid])
    ).filter((m) => !m.archived);
  }
  async saveMedication(uid: string, data: unknown, id?: string) {
    const m = MedicationSchema.parse(data);
    if (m.licenseNo && !(await this.catalog.get(m.licenseNo)))
      return fail(
        "unknown_license",
        "請從官方藥品索引選擇許可證，或先以未匹配草稿保存。",
      );
    const key = id || randomUUID();
    const med = await this.store.transaction(async (tx) => {
      const user = await tx.get<Account>("users", uid);
      if (!user || user.disabled || user.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      const old = await tx.get<Medication>("medications", key);
      if (id && (!old || old.ownerId !== uid || old.archived))
        return fail("not_found", "找不到藥品。", 404);
      const result: Medication = {
        ...m,
        id: key,
        ownerId: uid,
        revision: (old?.revision || 0) + 1,
        archived: false,
        createdAt: old?.createdAt || now(),
        updatedAt: now(),
      };
      tx.set("medications", key, result);
      return result;
    });
    await this.invalidateMedication(uid, key);
    return med;
  }
  async invalidateMedication(uid: string, id: string) {
    for (const s of await this.store.list<Schedule>("schedules", [
      "ownerId",
      uid,
    ]))
      if (s.medicationId === id && s.active)
        await this.store.set("schedules", s.id, { ...s, active: false });
    for (const q of await this.store.list("learning", ["ownerId", uid]))
      if (q.medicationIds?.includes(id))
        await this.store.delete("learning", q.id);
  }
  async removeMedication(uid: string, id: string) {
    const m = await this.owned<Medication>("medications", id, uid);
    await this.writePrivate(uid, "medications", id, {
      ...m,
      archived: true,
      revision: m.revision + 1,
      updatedAt: now(),
    });
    await this.invalidateMedication(uid, id);
  }
  async saveSchedule(uid: string, data: unknown) {
    const s = ScheduleSchema.parse(data);
    if (s.endDate && s.endDate < s.startDate)
      return fail("invalid_date", "結束日期不能早於開始日期。");
    const med = await this.owned<Medication>(
      "medications",
      s.medicationId,
      uid,
    );
    if (med.archived || !med.confirmed || med.prn)
      return fail(
        "unconfirmed_usage",
        "請先確認定時用法；需要時服用的藥不排固定提醒。",
      );
    const id = hash(uid + "|" + s.medicationId);
    const result: Schedule = {
      ...s,
      id,
      ownerId: uid,
      active: true,
      medicationRevision: med.revision,
      nextAt: nextTime(s, now()),
    };
    await this.writePrivate(uid, "schedules", id, result);
    return result;
  }
  async today(
    uid: string,
    date = DateTime.now().setZone("Asia/Taipei").toISODate()!,
  ) {
    const schedules = await this.store.list<Schedule>("schedules", [
      "ownerId",
      uid,
    ]);
    const meds = await this.medications(uid);
    const logs = await this.store.list(
      "doseLogs",
      ["ownerId", uid],
      ["date", date],
    );
    return schedules
      .filter(
        (s) =>
          s.active && s.startDate <= date && (!s.endDate || s.endDate >= date),
      )
      .flatMap((s) => {
        const med = meds.find(
          (m) =>
            m.id === s.medicationId &&
            m.confirmed &&
            m.revision === s.medicationRevision,
        );
        if (!med) return [];
        return s.times.map((time) => {
          const dueAt = DateTime.fromISO(date + "T" + time, {
            zone: s.timezone,
          })
            .toUTC()
            .toISO()!;
          const id = hash(s.id + "|" + s.medicationRevision + "|" + dueAt);
          return {
            id,
            scheduleId: s.id,
            medicationId: med.id,
            name: med.name,
            doseAmount: med.doseAmount,
            doseUnit: med.doseUnit,
            dueAt,
            time,
            log: logs.find((l) => l.id === id) || null,
          };
        });
      })
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }
  async doseLog(uid: string, data: Doc) {
    const { z } = await import("zod");
    const b = z
      .object({
        medicationId: z.string(),
        dueAt: z.string().datetime().nullable(),
        status: z.enum(["taken", "skipped"]),
        note: z.string().max(300).default(""),
        operationId: z.string().uuid().optional(),
      })
      .parse(data);
    const med = await this.owned<Medication>(
      "medications",
      b.medicationId,
      uid,
    );
    if (!med.confirmed || med.archived)
      return fail("unconfirmed_usage", "請先確認用法。");
    let id: string;
    if (med.prn) {
      if (!b.operationId) return fail("invalid_request", "需要操作識別碼。");
      id = hash(uid + "|prn|" + b.operationId);
    } else {
      if (!b.dueAt) return fail("invalid_request", "需要排程時間。");
      const date = DateTime.fromISO(b.dueAt)
        .setZone("Asia/Taipei")
        .toISODate()!;
      const occurrence = (await this.today(uid, date)).find(
        (x) => x.medicationId === med.id && x.dueAt === b.dueAt,
      );
      if (!occurrence)
        return fail("invalid_occurrence", "找不到有效排程，請重新整理。");
      id = occurrence.id;
    }
    return this.store.transaction(async (tx) => {
      const user = await tx.get<Account>("users", uid);
      if (!user || user.disabled || user.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      const old = await tx.get("doseLogs", id);
      if (old && old.status === b.status && old.note === b.note) return old;
      const r = {
        id,
        ownerId: uid,
        medicationId: med.id,
        name: med.name,
        dueAt: b.dueAt,
        date: DateTime.fromISO(b.dueAt || now())
          .setZone("Asia/Taipei")
          .toISODate(),
        status: b.status,
        note: b.note,
        recordedAt: old?.recordedAt || now(),
        updatedAt: now(),
        revision: (old?.revision || 0) + 1,
      };
      tx.set("doseLogs", id, r);
      if (old && old.status !== r.status) {
        const correctionId = randomUUID();
        tx.set("doseCorrections", correctionId, {
          id: correctionId,
          ownerId: uid,
          logId: id,
          previous: old.status,
          status: r.status,
          at: now(),
        });
      }
      return r;
    });
  }
  async saveCabinet(uid: string, data: unknown, id?: string) {
    const b = CabinetSchema.parse(data);
    if (id) await this.owned("cabinet", id, uid);
    if (b.medicationId) await this.owned("medications", b.medicationId, uid);
    const r = { ...b, id: id || randomUUID(), ownerId: uid, updatedAt: now() };
    await this.writePrivate(uid, "cabinet", r.id, r);
    return r;
  }
  async duplicates(uid: string) {
    const meds = await this.medications(uid);
    const aliases =
      (await this.store.get("settings", "ingredientAliases")) || {};
    const ingredients = new Map<string, string[]>();
    for (const m of meds) {
      const d = m.licenseNo ? await this.catalog.get(m.licenseNo) : null;
      for (const raw of d?.ingredients || []) {
        const key = String(aliases[raw.toLowerCase()] || raw)
          .toLowerCase()
          .trim();
        ingredients.set(key, [
          ...new Set([...(ingredients.get(key) || []), m.name]),
        ]);
      }
    }
    return [...ingredients]
      .filter(([, names]) => names.length > 1)
      .map(([ingredient, medications]) => ({ ingredient, medications }));
  }
  async invite(uid: string, verified: boolean) {
    if (!verified) return fail("email_unverified", "請先完成信箱驗證。", 403);
    const code = randomBytes(9).toString("base64url").toUpperCase();
    const id = hash(code);
    await this.writePrivate(uid, "invites", id, {
      id,
      ownerId: uid,
      expiresAt: Date.now() + 86400000,
      usedBy: null,
    });
    return { code, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  }
  async accept(uid: string, code: string, verified: boolean) {
    if (!verified) return fail("email_unverified", "請先完成信箱驗證。", 403);
    const attemptKey = hash(uid + "|" + Math.floor(Date.now() / 600000));
    await this.store.transaction(async (tx) => {
      const n = await tx.get("inviteAttempts", attemptKey);
      if ((n?.count || 0) >= 10)
        return fail("rate_limited", "邀請碼嘗試太多，請十分鐘後再試。", 429);
      tx.set("inviteAttempts", attemptKey, {
        id: attemptKey,
        ownerId: uid,
        count: (n?.count || 0) + 1,
      });
    });
    return this.store.transaction(async (tx) => {
      const caregiver = await tx.get<Account>("users", uid);
      if (!caregiver || caregiver.disabled || caregiver.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      const inv = await tx.get("invites", hash(code.trim().toUpperCase()));
      if (
        !inv ||
        inv.usedBy ||
        inv.expiresAt < Date.now() ||
        inv.ownerId === uid
      )
        return fail("invalid_invite", "邀請碼無效或已過期。");
      const owner = await tx.get<Account>("users", inv.ownerId);
      if (!owner || owner.disabled || owner.deleting)
        return fail("invalid_invite", "邀請碼無效。");
      const id = hash(inv.ownerId + "|" + uid);
      const r = {
        id,
        ownerId: inv.ownerId,
        caregiverId: uid,
        active: true,
        createdAt: now(),
      };
      tx.set("relationships", id, r);
      tx.set("invites", inv.id, { ...inv, usedBy: uid });
      return r;
    });
  }
  async relationships(uid: string): Promise<Doc[]> {
    const rows = [
      ...(await this.store.list("relationships", ["ownerId", uid])),
      ...(await this.store.list("relationships", ["caregiverId", uid])),
    ];
    return Promise.all(
      rows
        .filter((r) => r.active)
        .map(async (r) => {
          const other = await this.store.get<Account>(
            "users",
            r.ownerId === uid ? r.caregiverId : r.ownerId,
          );
          return {
            ...r,
            displayName: other?.displayName || "家人",
            direction: r.ownerId === uid ? "shared" : "receiving",
          };
        }),
    );
  }
  async revoke(uid: string, id: string) {
    const r = await this.owned("relationships", id, uid);
    await this.store.set("relationships", id, {
      ...r,
      active: false,
      revokedAt: now(),
    });
  }
  async snapshot(uid: string, ownerId: string) {
    const r = await this.store.get("relationships", hash(ownerId + "|" + uid));
    if (!r?.active) return fail("forbidden", "對方未授權或已取消授權。", 403);
    const owner = await this.active(ownerId);
    return {
      displayName: owner.displayName,
      medications: (await this.medications(ownerId)).map(
        ({ id, name, doseAmount, doseUnit, frequencyRaw, confirmed, prn }) => ({
          id,
          name,
          doseAmount,
          doseUnit,
          frequencyRaw,
          confirmed,
          prn,
        }),
      ),
      today: await this.today(ownerId),
      logs: (await this.store.list("doseLogs", ["ownerId", ownerId]))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 100)
        .map(({ id, name, status, dueAt, recordedAt }) => ({
          id,
          name,
          status,
          dueAt,
          recordedAt,
        })),
      updatedAt: now(),
    };
  }
  async published(licenseNo: string) {
    const p = await this.store.get("published", hash(licenseNo));
    return p ? this.store.get<Leaflet>("leaflets", p.leafletId) : null;
  }
  async search(q: string, strength = "", form = "") {
    return Promise.all(
      (await this.catalog.search(q, strength, form)).map(async (d) => ({
        ...d,
        hasLeaflet: !!(await this.published(d.licenseNo)),
      })),
    );
  }
  async enqueueJob(
    uid: string,
    verified: boolean,
    kind: JobKind,
    input: Doc,
    key: string,
  ) {
    if (!verified) return fail("email_unverified", "請先完成信箱驗證。", 403);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(key))
      return fail("invalid_request", "缺少有效的 Idempotency-Key。");
    const u = await this.active(uid);
    if (!u.eligible)
      return fail("not_eligible", "此帳號尚未取得測試資格。", 403);
    if (!config.nvidiaKey && this.llmFactory().constructor === Nvidia)
      return fail(
        "ai_not_configured",
        "尚未設定 NVIDIA 金鑰，可先手動建檔。",
        503,
      );
    const id = hash(uid + "|" + kind + "|" + key);
    const payloadHash = hash(
      JSON.stringify(
        kind === "recognition"
          ? { imageHash: input.imageHash, mediaType: input.mediaType }
          : input,
      ),
    );
    const day = DateTime.now().setZone("Asia/Taipei").toISODate()!;
    const uk = hash(uid + "|" + day),
      gk = "global-" + day;
    const job = await this.store.transaction(async (tx) => {
      const currentUser = await tx.get<Account>("users", uid);
      if (!currentUser || currentUser.disabled || currentUser.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      if (!currentUser.eligible)
        return fail("not_eligible", "此帳號尚未取得測試資格。", 403);
      const old = await tx.get<Job & { payloadHash: string }>("jobs", id);
      if (old) {
        if (old.payloadHash !== payloadHash)
          return fail(
            "idempotency_conflict",
            "相同操作識別碼不能用於不同輸入。",
            409,
          );
        return old;
      }
      const user = await tx.get("usage", uk);
      const global = await tx.get("usage", gk);
      if (
        (user?.count || 0) >= config.userLimit ||
        (global?.count || 0) >= config.globalLimit
      )
        return fail("quota_exceeded", "今日 AI 使用額度已達上限。", 429);
      const j = {
        id,
        ownerId: uid,
        kind,
        status: "queued" as const,
        input,
        result: null,
        error: null,
        createdAt: now(),
        updatedAt: now(),
        leaseUntil: 0,
        attempts: 0,
        payloadHash,
      };
      tx.set("jobs", id, j);
      tx.set("usage", uk, {
        id: uk,
        ownerId: uid,
        date: day,
        count: (user?.count || 0) + 1,
      });
      tx.set("usage", gk, {
        id: gk,
        date: day,
        count: (global?.count || 0) + 1,
      });
      return j;
    });
    if (job.status === "queued" && this.enqueue)
      try {
        await this.enqueue(id);
      } catch {
        throw new AppError(
          "queue_unavailable",
          "背景服務暫時無法排入，請以原操作重試。",
          503,
        );
      }
    return job;
  }
  async processJob(id: string) {
    const claimed = await this.store.transaction(async (tx) => {
      const j = await tx.get<Job>("jobs", id);
      if (!j || j.status === "succeeded" || j.status === "failed") return null;
      if (j.status === "running" && j.leaseUntil > Date.now()) return null;
      if (j.attempts >= 3 && j.kind !== "delete-account") {
        tx.set("jobs", id, {
          ...j,
          status: "failed",
          leaseUntil: 0,
          error: {
            code: "retry_limit",
            message: "任務已達嘗試上限，請重新發出請求。",
          },
          updatedAt: now(),
        });
        return null;
      }
      const n = {
        ...j,
        status: "running" as const,
        leaseUntil: Date.now() + 540000,
        attempts: j.attempts + 1,
        updatedAt: now(),
      };
      tx.set("jobs", id, n);
      return n;
    });
    if (!claimed) return;
    const j = claimed;
    const startedAt = Date.now();
    const llm = this.llmFactory();
    const writes: Array<[string, string, Doc]> = [];
    let inputRevisions: Array<{ id: string; revision: number }> = [];
    try {
      if (j.kind === "delete-account") {
        await this.cleanupUser(j.ownerId);
        return;
      }
      const u = await this.active(j.ownerId);
      if (!u.eligible)
        return fail("not_eligible", "此帳號目前沒有 AI 測試資格。", 403);
      let result: unknown;
      if (j.kind === "recognition") {
        const image = await this.blobs.get(String(j.input.imagePath));
        const r = await recognize(llm, image, String(j.input.mediaType));
        result = {
          ...r,
          medications: await Promise.all(
            r.medications.map(async (m) => ({
              ...m,
              candidates: await this.search(
                m.name,
                m.strength || "",
                m.form || "",
              ),
            })),
          ),
        };
      } else {
        const ids = j.input.medicationIds as string[];
        const meds = await Promise.all(
          ids.map((id) => this.owned<Medication>("medications", id, j.ownerId)),
        );
        inputRevisions = meds.map((m) => ({ id: m.id, revision: m.revision }));
        if (meds.some((m) => !m.confirmed || m.archived))
          return fail("unconfirmed_usage", "請先確認藥品。");
        const leaflets = await Promise.all(
          meds.map((m) => (m.licenseNo ? this.published(m.licenseNo) : null)),
        );
        const chunks = leaflets.flatMap((l) =>
          l?.status === "published" ? l.chunks : [],
        );
        const profile = await this.store.get("profiles", j.ownerId);
        const catalogDrugs = await Promise.all(
          meds.map((m) => (m.licenseNo ? this.catalog.get(m.licenseNo) : null)),
        );
        const ingredientAliases =
          (await this.store.get("settings", "ingredientAliases")) || {};
        const context = {
          medications: meds.map((m, i) => ({
            licenseNo: m.licenseNo,
            name: m.name,
            identityTerms: [
              ...new Set(
                [
                  catalogDrugs[i]?.nameZh,
                  catalogDrugs[i]?.nameEn,
                  ...(catalogDrugs[i]?.ingredients || []).flatMap(
                    (ingredient) => {
                      const canonical = String(
                        ingredientAliases[ingredient.toLowerCase()] ||
                          ingredient,
                      ).toLowerCase();
                      return [
                        ingredient,
                        canonical,
                        ...Object.entries(ingredientAliases)
                          .filter(
                            ([, v]) => String(v).toLowerCase() === canonical,
                          )
                          .map(([k]) => k),
                      ];
                    },
                  ),
                ].filter((s): s is string => !!s),
              ),
            ],
            usage: [
              m.doseAmount,
              m.doseUnit,
              m.frequencyRaw,
              m.instructions,
            ].join(" "),
          })),
          profile: profile
            ? {
                age: profile.age,
                sex: profile.sex,
                conditions: profile.conditions,
                allergies: profile.allergies,
                pregnancy: profile.pregnancy,
                notes: profile.notes,
              }
            : null,
        };
        const ck = hash(
          JSON.stringify({
            uid: j.ownerId,
            profile: u.profileVersion,
            kind: j.kind,
            question: j.input.question,
            medications: meds.map((m) => [m.id, m.revision]),
            identities: context.medications.map((m) => m.identityTerms),
            versions: leaflets.map((l) => [l?.sha256, l?.version]),
            model: config.textModel,
            prompt: GROUNDING_VERSION,
          }),
        );
        const cached = await this.store.get("generated", ck);
        result = cached?.result;
        if (!result) {
          result = leaflets.some((l) => !l)
            ? {
                status: "insufficient_data",
                claims: [],
                chunks: [],
                quiz: [],
                followups: [],
                rejectedCount: 0,
                sourceVersions: {},
                verification: "model_assisted",
              }
            : await grounded(
                llm,
                String(
                  j.input.question ||
                    "請提供藥品用途、用法資訊、注意事項、警語、追問與小測驗。",
                ),
                chunks,
                context,
                j.kind,
              );
          writes.push([
            "generated",
            ck,
            {
              id: ck,
              ownerId: j.ownerId,
              result,
              createdAt: now(),
            },
          ]);
        }
        if (j.kind === "chat")
          writes.push([
            "chats",
            id,
            {
              id,
              ownerId: j.ownerId,
              question: j.input.question,
              result,
              createdAt: now(),
            },
          ]);
        else
          writes.push([
            "learning",
            id,
            {
              id,
              ownerId: j.ownerId,
              medicationIds: ids,
              medicationRevisions: meds.map((m) => ({
                id: m.id,
                revision: m.revision,
              })),
              profileVersion: u.profileVersion,
              result,
              answers: {},
              createdAt: now(),
            },
          ]);
      }
      await this.store.transaction(async (tx) => {
        const currentUser = await tx.get<Account>("users", j.ownerId);
        const currentJob = await tx.get<Job>("jobs", id);
        if (
          !currentUser ||
          currentUser.disabled ||
          currentUser.deleting ||
          !currentJob ||
          currentJob.attempts !== j.attempts
        )
          return;
        if (currentUser.profileVersion !== u.profileVersion)
          return fail(
            "stale_content",
            "個人資料已更新，請重試產生新內容。",
            409,
          );
        for (const expected of inputRevisions) {
          const m = await tx.get<Medication>("medications", expected.id);
          if (!m || m.archived || m.revision !== expected.revision)
            return fail(
              "stale_content",
              "藥品資料已更新，請重試產生新內容。",
              409,
            );
        }
        const versions = (result as GroundedResult)?.sourceVersions || {};
        for (const [license, version] of Object.entries(versions)) {
          const pointer = await tx.get("published", hash(license));
          const leaflet = pointer
            ? await tx.get<Leaflet>("leaflets", pointer.leafletId)
            : null;
          if (!leaflet || leaflet.version !== version)
            return fail("stale_content", "仿單已更新，請重試產生新內容。", 409);
        }
        for (const [collection, key, value] of writes)
          tx.set(collection, key, value);
        tx.set("jobs", id, {
          ...j,
          input: {},
          result,
          status: "succeeded",
          leaseUntil: 0,
          updatedAt: now(),
          tokens: llm instanceof Nvidia ? llm.tokens : 0,
          latencyMs: Date.now() - startedAt,
        });
      });
    } catch (e) {
      const error =
        e instanceof AppError
          ? { code: e.code, message: e.message }
          : { code: "generation_failed", message: "處理失敗，請稍後重試。" };
      await this.store.transaction(async (tx) => {
        const currentUser = await tx.get<Account>("users", j.ownerId);
        const currentJob = await tx.get<Job>("jobs", id);
        if (
          j.kind !== "delete-account" &&
          (!currentUser ||
            currentUser.deleting ||
            !currentJob ||
            currentJob.attempts !== j.attempts)
        )
          return;
        tx.set("jobs", id, {
          ...j,
          input: j.kind === "recognition" ? {} : j.input,
          status: "failed",
          error,
          leaseUntil: 0,
          updatedAt: now(),
          tokens: llm instanceof Nvidia ? llm.tokens : 0,
          latencyMs: Date.now() - startedAt,
        });
      });
    } finally {
      if (j.kind === "recognition" && j.input.imagePath)
        await this.blobs.delete(String(j.input.imagePath));
    }
  }
  async retryJob(uid: string, id: string) {
    await this.store.transaction(async (tx) => {
      const j = await tx.get<Job>("jobs", id);
      if (!j || j.ownerId !== uid)
        return fail("not_found", "找不到任務。", 404);
      if (j.status === "queued" || j.status === "running") return;
      if (j.status !== "failed" || j.kind === "recognition")
        return fail("cannot_retry", "此任務不能重試，照片辨識請重新上傳。");
      if (j.attempts >= 3)
        return fail("retry_limit", "已達重試次數，請稍後建立新請求。");
      tx.set("jobs", id, { ...j, status: "queued", error: null });
    });
    if (this.enqueue) await this.enqueue(id);
    return { jobId: id };
  }
  async audit(actor: string, action: string, target: string) {
    const id = randomUUID();
    await this.store.set("audit", id, { id, actor, action, target, at: now() });
  }
  async setUser(
    actor: string,
    id: string,
    data: { disabled?: boolean; eligible?: boolean },
  ) {
    await this.store.transaction(async (tx) => {
      const u = await tx.get<Account>("users", id);
      if (!u) return fail("not_found", "找不到帳號。", 404);
      if (u.deleting)
        return fail("account_deleted", "刪除中的帳號不能恢復。", 409);
      if (id === actor && data.disabled)
        return fail("invalid_request", "不能停用自己。");
      const seats = (await tx.get("settings", "testerSeats")) || {
        uids: [] as string[],
      };
      const next = { ...u, ...data };
      const members = new Set<string>(seats.uids);
      if (next.eligible && !next.disabled) members.add(id);
      else members.delete(id);
      if (members.size > 50) return fail("capacity", "測試名額已滿。");
      tx.set("settings", "testerSeats", { uids: [...members] });
      tx.set("users", id, next);
    });
    if (config.mode === "firebase" && data.disabled !== undefined) {
      await getAuth(firebaseApp()).updateUser(id, { disabled: data.disabled });
      if (data.disabled) await getAuth(firebaseApp()).revokeRefreshTokens(id);
    }
    await this.audit(actor, "account.update", id);
  }
  async learningCurrent(uid: string, row: Doc) {
    const u = await this.active(uid);
    if (row.profileVersion !== u.profileVersion) return false;
    const meds = await this.medications(uid);
    if (
      !row.medicationRevisions.every((r: { id: string; revision: number }) =>
        meds.some((m) => m.id === r.id && m.revision === r.revision),
      )
    )
      return false;
    for (const [license, version] of Object.entries(
      row.result.sourceVersions || {},
    )) {
      const current = await this.published(license);
      if (current?.version !== version) return false;
    }
    return true;
  }
  async publish(actor: string, id: string) {
    const l = await this.store.get<Leaflet>("leaflets", id);
    if (!l || !l.chunks.length)
      return fail("invalid_leaflet", "仿單未完成文字整理。");
    if (!(await this.catalog.get(l.licenseNo)))
      return fail("unknown_license", "許可證不在主檔中。");
    await this.store.transaction(async (tx) => {
      const oldPointer = await tx.get("published", hash(l.licenseNo));
      const old = oldPointer
        ? await tx.get<Leaflet>("leaflets", oldPointer.leafletId)
        : null;
      if (old && old.id !== id)
        tx.set("leaflets", old.id, { ...old, status: "retired" });
      tx.set("leaflets", id, {
        ...l,
        status: "published",
        checkedBy: actor,
        checkedAt: now(),
      });
      tx.set("published", hash(l.licenseNo), {
        leafletId: id,
        version: l.version,
      });
    });
    await this.audit(actor, "leaflet.publish", id);
  }
  async exportUser(uid: string) {
    const result: Doc = {
      exportedAt: now(),
      profile: await this.store.get("profiles", uid),
    };
    for (const c of [
      "medications",
      "schedules",
      "doseLogs",
      "doseCorrections",
      "cabinet",
      "chats",
      "learning",
    ])
      result[c] = await this.store.list(c, ["ownerId", uid]);
    return result;
  }
  async deleteAccount(uid: string) {
    const id = "delete-" + hash(uid);
    await this.store.transaction(async (tx) => {
      const u = await tx.get<Account>("users", uid);
      if (!u) return fail("not_found", "找不到帳號。", 404);
      const existing = await tx.get("jobs", id);
      tx.set("users", uid, { ...u, disabled: true, deleting: true });
      if (!existing)
        tx.set("jobs", id, {
          id,
          ownerId: uid,
          kind: "delete-account",
          status: "queued",
          input: {},
          result: null,
          error: null,
          createdAt: now(),
          updatedAt: now(),
          leaseUntil: 0,
          attempts: 0,
        });
    });
    if (config.mode === "firebase") {
      await getAuth(firebaseApp()).updateUser(uid, { disabled: true });
      await getAuth(firebaseApp()).revokeRefreshTokens(uid);
    }
    for (const rel of await this.relationships(uid))
      await this.store.set("relationships", rel.id, { ...rel, active: false });
    if (this.enqueue) await this.enqueue(id);
    return { status: "deleting" };
  }
  async cleanupUser(uid: string) {
    for (const j of await this.store.list<Job>("jobs", ["ownerId", uid]))
      if (j.input.imagePath) await this.blobs.delete(String(j.input.imagePath));
    for (const c of [
      "profiles",
      "medications",
      "schedules",
      "doseLogs",
      "doseCorrections",
      "cabinet",
      "chats",
      "learning",
      "generated",
      "devices",
      "invites",
      "inviteAttempts",
      "usage",
      "notifications",
      "jobs",
    ])
      for (const r of await this.store.list(c, ["ownerId", uid]))
        if (!(c === "jobs" && r.kind === "delete-account"))
          await this.store.delete(c, r.id);
    for (const n of await this.store.list("notifications", [
      "recipientId",
      uid,
    ]))
      await this.store.delete("notifications", n.id);
    for (const r of await this.store.list("relationships"))
      if (r.ownerId === uid || r.caregiverId === uid)
        await this.store.delete("relationships", r.id);
    await this.store.delete("profiles", uid);
    if (config.mode === "firebase")
      await getAuth(firebaseApp())
        .deleteUser(uid)
        .catch((e: any) => {
          if (e.code !== "auth/user-not-found") throw e;
        });
    await this.store.set("users", uid, {
      id: uid,
      disabled: true,
      deleting: true,
      deletedAt: now(),
    });
    await this.store.transaction(async (tx) => {
      const seats = await tx.get("settings", "testerSeats");
      if (seats)
        tx.set("settings", "testerSeats", {
          uids: seats.uids.filter((id: string) => id !== uid),
        });
      tx.delete("jobs", "delete-" + hash(uid));
    });
  }
}
