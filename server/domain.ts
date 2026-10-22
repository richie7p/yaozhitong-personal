import { createHash, randomUUID, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
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
  type LearningRecord,
} from "../shared/schema.js";
import { learningProgress, validAnswers } from "../shared/learning.js";
import { doseLabel } from "../shared/medication.js";
import type { ProductIdentityIndex } from "../shared/product-identity.js";
import {
  aiConnection,
  aiRoutingIdentity,
  config,
  fail,
  AppError,
} from "./config.js";
import { firebaseApp, type Store, type Doc } from "./store.js";
import { Blobs } from "./blobs.js";
import { jobFailureEvent } from "./job-telemetry.js";
import { localWorkerBootTime } from "./local-runner.js";
import { nextTime, initialFamilyTime } from "./schedule-time.js";
import { requestReminderRefresh } from "./reminder-state.js";
import { withSourceReviewResult } from "./source-review-result.js";
export { nextTime } from "./schedule-time.js";
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
const jobPayloadHash = (kind: JobKind, input: Doc) =>
  hash(
    JSON.stringify(
      kind === "recognition"
        ? { imageHash: input.imageHash, mediaType: input.mediaType }
        : input,
    ),
  );
type HistoryReader = Pick<Store, "get"> & {
  identityCatalog?: Promise<ProductIdentityIndex>;
};
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
  aiAccess(account: Account) {
    return config.publicAccess === "verified" || account.eligible;
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
      const previous = await tx.get("profiles", uid);
      tx.set("profiles", uid, { ...p, id: uid, ownerId: uid });
      if (!!previous?.notifyFamily !== p.notifyFamily)
        requestReminderRefresh(tx, uid);
      tx.set("users", uid, {
        ...u,
        displayName: p.displayName,
        profileVersion: u.profileVersion + 1,
      });
    });
    return p;
  }
  async medications(uid: string) {
    const catalog = await this.catalog.identitySnapshot();
    return Promise.all(
      (await this.store.list<Medication>("medications", ["ownerId", uid]))
        .filter((m) => !m.archived)
        .map((m) => this.reviewedMedication(m, catalog)),
    );
  }
  async reviewedMedication(m: Medication, catalog?: ProductIdentityIndex) {
    const identityReview = catalog
      ? catalog.review(m)
      : await this.catalog.identityReview(m);
    return {
      ...m,
      candidateLicenseNo:
        m.candidateLicenseNo ||
        m.licenseNo ||
        identityReview.candidate?.licenseNo ||
        null,
      licenseNo:
        identityReview.status === "confirmed"
          ? identityReview.candidate!.licenseNo
          : null,
      identityReview,
    };
  }
  private async normalizeMedication(data: unknown) {
    const parsed = MedicationSchema.parse(data);
    const identityReview = await this.catalog.identityReview(parsed);
    return {
      ...parsed,
      candidateLicenseNo:
        parsed.candidateLicenseNo ||
        parsed.licenseNo ||
        identityReview.candidate?.licenseNo ||
        null,
      licenseNo:
        identityReview.status === "confirmed"
          ? identityReview.candidate!.licenseNo
          : null,
    };
  }
  async saveMedication(uid: string, data: unknown, id?: string) {
    const m = await this.normalizeMedication(data);
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
    return this.reviewedMedication(med);
  }
  async saveRecognizedMedication(
    uid: string,
    jobId: string,
    index: number,
    data: unknown,
  ) {
    const m = await this.normalizeMedication(data);
    const saved = await this.store.transaction(async (tx) => {
      const user = await tx.get<Account>("users", uid);
      if (!user || user.disabled || user.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      const job = await tx.get<Job>("jobs", jobId);
      if (!job || job.ownerId !== uid || job.kind !== "recognition")
        return fail("not_found", "找不到辨識紀錄。", 404);
      const rows = (job.result as any)?.medications;
      if (
        job.status !== "succeeded" ||
        !Number.isInteger(index) ||
        index < 0 ||
        !Array.isArray(rows) ||
        !rows[index]
      )
        return fail("invalid_recognition", "這筆辨識尚未完成或已無法核對。");
      const key = hash(uid + "|recognition-medication|" + jobId + "|" + index);
      const old = await tx.get<Medication>("medications", key);
      // A lost response or a second tab must not duplicate or overwrite a saved row.
      if (old) {
        if (old.archived)
          return fail(
            "already_saved",
            "這筆辨識曾儲存後已移除，請先到我的藥品確認；需要新增時可重新建檔。",
            409,
          );
        if (
          JSON.stringify(await this.normalizeMedication(old)) !==
          JSON.stringify(m)
        )
          return fail(
            "recognition_saved_conflict",
            "這筆辨識已儲存，與目前編輯內容不同。請到我的藥品編輯已儲存的資料。",
            409,
          );
        return old;
      }
      if (job.savedMedications?.[String(index)])
        return fail("already_saved", "這筆辨識已儲存，請到我的藥品查看。", 409);
      const med: Medication = {
        ...m,
        id: key,
        ownerId: uid,
        revision: 1,
        archived: false,
        createdAt: now(),
        updatedAt: now(),
      };
      tx.set("medications", key, med);
      tx.set("jobs", jobId, {
        ...job,
        savedMedications: {
          ...job.savedMedications,
          [String(index)]: { id: key, name: m.name },
        },
      });
      return med;
    });
    return this.reviewedMedication(saved);
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
    const clock = new Date();
    const result: Schedule = {
      ...s,
      id,
      ownerId: uid,
      active: true,
      medicationRevision: med.revision,
      nextAt: nextTime(s, clock.toISOString()),
      nextFamilyAt: initialFamilyTime(s, clock),
      reminderSchemaVersion: 1,
      reminderVersion: randomUUID(),
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
            doseText: med.doseText || "",
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
      requestReminderRefresh(tx, inv.ownerId);
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
        ({
          id,
          name,
          doseAmount,
          doseUnit,
          doseText,
          frequencyRaw,
          confirmed,
          prn,
        }) => ({
          id,
          name,
          doseAmount,
          doseUnit,
          doseText: doseText || "",
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
  private async jobMedications(
    uid: string,
    kind: JobKind,
    input: Doc,
    reader: HistoryReader = this.store,
  ) {
    if (kind === "recognition" || kind === "delete-account") return [];
    const ids = z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(kind === "interaction" ? 2 : 8)
      .parse(input.medicationIds);
    if (kind === "interaction" && (ids.length !== 2 || new Set(ids).size !== 2))
      return fail("invalid_request", "請選擇兩款不同藥品。");
    const catalog = await this.catalog.identitySnapshot();
    const medications: Medication[] = [];
    for (const id of ids) {
      const medication = await reader.get<Medication>("medications", id);
      if (!medication || medication.ownerId !== uid || medication.archived)
        return fail("not_found", "找不到藥品。", 404);
      const reviewed = await this.reviewedMedication(medication, catalog);
      if (reviewed.identityReview.status !== "confirmed")
        return fail(
          "identity_unconfirmed",
          "藥品身分尚未核對，請補拍包裝或補上完整許可證、品名、含量與劑型後再產生內容。",
          409,
        );
      if (
        !medication.confirmed ||
        !MedicationSchema.safeParse(medication).success
      )
        return fail("unconfirmed_usage", "請先核對藥袋的用量與頻次。");
      medications.push(reviewed);
    }
    return medications;
  }
  private async authorizeJob(uid: string, verified: boolean, key: string) {
    if (!verified) return fail("email_unverified", "請先完成信箱驗證。", 403);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(key))
      return fail("invalid_request", "缺少有效的 Idempotency-Key。");
    const u = await this.active(uid);
    if (!this.aiAccess(u))
      return fail("not_eligible", "此帳號尚未取得測試資格。", 403);
    if (!aiConnection().key && this.llmFactory().constructor === Nvidia)
      return fail(
        "ai_not_configured",
        `尚未設定 ${aiConnection().label} 金鑰，可先手動建檔。`,
        503,
      );
  }
  /** Read-only admission check before expensive photo decode or blob writes.
   * enqueueJob still repeats access/quota checks in its final transaction.
   */
  async preflightJob(
    uid: string,
    verified: boolean,
    kind: JobKind,
    input: Doc,
    key: string,
  ) {
    await this.jobMedications(uid, kind, input);
    await this.authorizeJob(uid, verified, key);
    const old = await this.store.get<Job & { payloadHash: string }>(
      "jobs",
      hash(uid + "|" + kind + "|" + key),
    );
    if (old) {
      if (old.payloadHash !== jobPayloadHash(kind, input))
        return fail(
          "idempotency_conflict",
          "相同操作識別碼不能用於不同輸入。",
          409,
        );
      return old;
    }
    const day = DateTime.now().setZone("Asia/Taipei").toISODate()!;
    const [user, global] = await Promise.all([
      this.store.get("usage", hash(uid + "|" + day)),
      this.store.get("usage", "global-" + day),
    ]);
    if (
      (user?.count || 0) >= config.userLimit ||
      (global?.count || 0) >= config.globalLimit
    )
      return fail("quota_exceeded", "今日 AI 使用額度已達上限。", 429);
    return null;
  }
  async enqueueJob(
    uid: string,
    verified: boolean,
    kind: JobKind,
    input: Doc,
    key: string,
  ) {
    await this.jobMedications(uid, kind, input);
    await this.authorizeJob(uid, verified, key);
    const id = hash(uid + "|" + kind + "|" + key);
    const payloadHash = jobPayloadHash(kind, input);
    const day = DateTime.now().setZone("Asia/Taipei").toISODate()!;
    const uk = hash(uid + "|" + day),
      gk = "global-" + day;
    const job = await this.store.transaction(async (tx) => {
      const currentUser = await tx.get<Account>("users", uid);
      if (!currentUser || currentUser.disabled || currentUser.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      if (!this.aiAccess(currentUser))
        return fail("not_eligible", "此帳號尚未取得測試資格。", 403);
      await this.jobMedications(uid, kind, input, tx);
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
    let exhaustedImagePath: string | undefined;
    const claimed = await this.store.transaction(async (tx) => {
      const j = await tx.get<Job>("jobs", id);
      if (!j || j.status === "succeeded" || j.status === "failed") return null;
      if (j.status === "running" && j.leaseUntil > Date.now()) return null;
      if (j.attempts >= 3 && j.kind !== "delete-account") {
        if (j.kind === "recognition" && j.input.imagePath)
          exhaustedImagePath = String(j.input.imagePath);
        tx.set("jobs", id, {
          ...j,
          input: j.kind === "recognition" ? {} : j.input,
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
        ...(config.mode === "local"
          ? { localWorkerPid: process.pid, localWorkerBootTime }
          : {}),
        updatedAt: now(),
      };
      tx.set("jobs", id, n);
      return n;
    });
    if (exhaustedImagePath) await this.blobs.delete(exhaustedImagePath);
    if (!claimed) return;
    const j = claimed;
    const startedAt = Date.now();
    let llm: Llm | undefined;
    const writes: Array<[string, string, Doc]> = [];
    let inputRevisions: Array<{ id: string; revision: number }> = [];
    let completedCurrentAttempt = false;
    try {
      if (j.kind === "delete-account") {
        await this.cleanupUser(j.ownerId);
        return;
      }
      const u = await this.active(j.ownerId);
      if (!this.aiAccess(u))
        return fail("not_eligible", "此帳號目前沒有 AI 測試資格。", 403);
      await this.jobMedications(j.ownerId, j.kind, j.input);
      llm = this.llmFactory();
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
        const meds = await this.jobMedications(j.ownerId, j.kind, j.input);
        inputRevisions = meds.map((m) => ({ id: m.id, revision: m.revision }));
        // Different saved prescriptions may refer to the same official leaflet.
        // Load each once so canonical source pages do not become duplicates.
        const leaflets = await Promise.all(
          [...new Set(meds.map((m) => m.licenseNo))].map(async (licenseNo) => {
            const leaflet = licenseNo ? await this.published(licenseNo) : null;
            return leaflet?.status === "published" &&
              leaflet.licenseNo === licenseNo
              ? leaflet
              : null;
          }),
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
            usage: [doseLabel(m), m.frequencyRaw, m.instructions].join(" "),
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
            provider: config.aiProvider,
            endpoint: aiConnection().base,
            model: config.textModel,
            routing: aiRoutingIdentity(),
            prompt: GROUNDING_VERSION,
          }),
        );
        const cached = await this.store.get("generated", ck);
        // Recheck just before consuming cached content or calling the model.
        const beforeGeneration = await this.jobMedications(
          j.ownerId,
          j.kind,
          j.input,
        );
        if (
          beforeGeneration.some(
            (m, i) =>
              m.revision !== meds[i].revision ||
              m.licenseNo !== meds[i].licenseNo,
          )
        )
          return fail(
            "stale_content",
            "藥品資料已更新，請重試產生新內容。",
            409,
          );
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
            : await withSourceReviewResult(
                () =>
                  grounded(
                    llm!,
                    String(
                      j.input.question ||
                        "請提供藥品用途、用法資訊、注意事項、警語、追問與小測驗。",
                    ),
                    chunks,
                    context,
                    j.kind,
                  ),
                leaflets as Leaflet[],
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
              medicationIds: [...ids],
              medicationRevisions: inputRevisions,
              profileVersion: u.profileVersion,
              groundingVersion: GROUNDING_VERSION,
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
              groundingVersion: GROUNDING_VERSION,
              result,
              answers: {},
              createdAt: now(),
            },
          ]);
      }
      completedCurrentAttempt = await this.store.transaction(async (tx) => {
        const currentUser = await tx.get<Account>("users", j.ownerId);
        const currentJob = await tx.get<Job>("jobs", id);
        if (
          !currentUser ||
          currentUser.disabled ||
          currentUser.deleting ||
          !currentJob ||
          currentJob.attempts !== j.attempts
        )
          return false;
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
        if (inputRevisions.length)
          await this.jobMedications(j.ownerId, j.kind, j.input, tx);
        const versions = (result as GroundedResult)?.sourceVersions || {};
        for (const [license, version] of Object.entries(versions)) {
          const pointer = await tx.get("published", hash(license));
          const leaflet = pointer
            ? await tx.get<Leaflet>("leaflets", pointer.leafletId)
            : null;
          if (
            !leaflet ||
            leaflet.status !== "published" ||
            leaflet.licenseNo !== license ||
            leaflet.version !== version
          )
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
          ...(llm instanceof Nvidia
            ? { aiRequests: JSON.parse(JSON.stringify(llm.requests)) }
            : {}),
          latencyMs: Date.now() - startedAt,
        });
        return true;
      });
    } catch (e) {
      const error =
        e instanceof AppError
          ? { code: e.code, message: e.message }
          : { code: "generation_failed", message: "處理失敗，請稍後重試。" };
      if (j.kind === "recognition")
        error.message = error.message.replace(
          "輸入已保留，請稍後重試。",
          "請重新上傳藥袋再試。",
        );
      completedCurrentAttempt = await this.store.transaction(async (tx) => {
        const currentUser = await tx.get<Account>("users", j.ownerId);
        const currentJob = await tx.get<Job>("jobs", id);
        if (
          j.kind !== "delete-account" &&
          (!currentUser ||
            currentUser.deleting ||
            !currentJob ||
            currentJob.attempts !== j.attempts)
        )
          return false;
        tx.set("jobs", id, {
          ...j,
          input: j.kind === "recognition" ? {} : j.input,
          status: "failed",
          error,
          leaseUntil: 0,
          updatedAt: now(),
          tokens: llm instanceof Nvidia ? llm.tokens : 0,
          ...(llm instanceof Nvidia
            ? { aiRequests: JSON.parse(JSON.stringify(llm.requests)) }
            : {}),
          latencyMs: Date.now() - startedAt,
        });
        return true;
      });
      if (completedCurrentAttempt)
        console.error(
          JSON.stringify(
            jobFailureEvent(
              j,
              error.code,
              e instanceof AppError ? e.status : 500,
            ),
          ),
        );
    } finally {
      // Only the attempt that committed a terminal state may remove its input.
      // A recovered worker can still need the same photo when an expired
      // attempt eventually returns or fails.
      if (
        completedCurrentAttempt &&
        j.kind === "recognition" &&
        j.input.imagePath
      )
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
      await this.jobMedications(uid, j.kind, j.input, tx);
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
      if (config.publicAccess === "verified" && data.eligible !== undefined)
        return fail(
          "invalid_request",
          "公開模式中，已驗證帳號皆可使用 AI；如需限制帳號請使用停用。",
        );
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
      if (u.disabled !== next.disabled) requestReminderRefresh(tx, id);
    });
    if (config.mode === "firebase" && data.disabled !== undefined) {
      await getAuth(firebaseApp()).updateUser(id, { disabled: data.disabled });
      if (data.disabled) await getAuth(firebaseApp()).revokeRefreshTokens(id);
    }
    await this.audit(actor, "account.update", id);
  }
  async learningCurrent(
    uid: string,
    row: Doc,
    reader: HistoryReader = this.store,
  ) {
    const u = await reader.get<Account>("users", uid);
    if (!u || u.disabled || u.deleting)
      return fail("account_disabled", "帳號已停用。", 403);
    if (row.groundingVersion !== GROUNDING_VERSION) return false;
    if (row.profileVersion !== u.profileVersion) return false;
    if (
      !Array.isArray(row.medicationRevisions) ||
      !Array.isArray(row.medicationIds)
    )
      return false;
    if (
      !row.medicationRevisions.length ||
      row.medicationIds.length !== row.medicationRevisions.length ||
      row.medicationIds.some(
        (id: string) => !row.medicationRevisions.some((r: Doc) => r.id === id),
      )
    )
      return false;
    const catalog = await (reader.identityCatalog ||
      this.catalog.identitySnapshot());
    for (const r of row.medicationRevisions) {
      const m = await reader.get<Medication>("medications", r.id);
      if (!m || m.ownerId !== uid || m.archived || m.revision !== r.revision)
        return false;
      if (!m.confirmed || catalog.review(m).status !== "confirmed")
        return false;
    }
    for (const [license, version] of Object.entries(
      row.result?.sourceVersions || {},
    )) {
      const pointer = await reader.get("published", hash(license));
      const current = pointer
        ? await reader.get<Leaflet>("leaflets", pointer.leafletId)
        : null;
      if (
        current?.status !== "published" ||
        current.licenseNo !== license ||
        current.version !== version
      )
        return false;
    }
    return true;
  }
  /** Promise memoization is scoped to one request; private data and catalog
   * proof are always loaded again for the next request. */
  historyReader(): HistoryReader {
    const reads = new Map<string, Promise<unknown>>();
    let snapshot: Promise<ProductIdentityIndex> | undefined;
    const loadCatalog = () => (snapshot ||= this.catalog.identitySnapshot());
    return {
      get identityCatalog() {
        return loadCatalog();
      },
      get: <T = Doc>(collection: string, id: string): Promise<T | null> => {
        const key = collection + "\0" + id;
        if (!reads.has(key)) reads.set(key, this.store.get(collection, id));
        return reads.get(key) as Promise<T | null>;
      },
    };
  }
  async chatHistory(uid: string, reader = this.historyReader()) {
    const rows = await this.store.list("chats", ["ownerId", uid]);
    const current = await Promise.all(
      rows.map((row) => this.learningCurrent(uid, row, reader)),
    );
    const items = rows.filter((_, index) => current[index]);
    return {
      items,
      hiddenUnsafeCount: rows.length - items.length,
      identityReviewRequired: rows.length !== items.length,
    };
  }
  jobSummary(job: Job) {
    const { input, ...summary } = job;
    if (job.kind === "recognition") return summary;
    return {
      ...summary,
      result: null,
      resultRequiresCheck: job.status === "succeeded",
      sourceReviewPending:
        job.status === "succeeded" &&
        (job.result as GroundedResult | null)?.status === "insufficient_data" &&
        (job.result as GroundedResult | null)?.sourceReview?.reason ===
          "safety_sections_pending",
      sourceReadingPending:
        job.status === "succeeded" &&
        (job.result as GroundedResult | null)?.status === "insufficient_data" &&
        ["model_source_capacity", "requested_topic_coverage"].includes(
          (job.result as GroundedResult | null)?.sourceReading?.reason || "",
        ),
    };
  }
  async publicJob(uid: string, job: Job, reader = this.historyReader()) {
    const { input, ...result } = job;
    if (
      job.status !== "succeeded" ||
      job.kind === "recognition" ||
      job.kind === "delete-account"
    )
      return result;
    const record = await reader.get(
      job.kind === "chat" ? "chats" : "learning",
      job.id,
    );
    if (
      record?.ownerId === uid &&
      (await this.learningCurrent(uid, record, reader))
    )
      return result;
    return {
      ...result,
      result: {
        status: "insufficient_data",
        claims: [],
        chunks: [],
        quiz: [],
        followups: [],
        rejectedCount: 0,
        sourceVersions: {},
        verification: "model_assisted",
      } satisfies GroundedResult,
      error: {
        code: "stale_content",
        message:
          "這份舊內容已過期，或藥品資料尚未完成核對。請確認藥品資料後重新產生。",
      },
      identityReviewRequired: true,
    };
  }
  async answerLearning(uid: string, id: string, data: unknown) {
    const b = z
      .object({
        answers: z.record(z.string(), z.number().int().nonnegative()),
      })
      .parse(data);
    return this.store.transaction(async (tx) => {
      const row = await tx.get<LearningRecord>("learning", id);
      if (!row || row.ownerId !== uid)
        return fail("not_found", "找不到學習內容。", 404);
      if (!(await this.learningCurrent(uid, row, tx)))
        return fail(
          "stale_content",
          "內容規則、仿單、藥品或個人資料已更新，請重新產生測驗。",
          409,
        );
      for (const [questionId, answer] of Object.entries(b.answers)) {
        const q = row.result.quiz.find((q) => q.id === questionId);
        if (!q || answer >= q.options.length)
          return fail(
            "invalid_answer",
            "題目或選項不存在，請重新載入學習內容。",
          );
      }
      const answers = {
        ...validAnswers(row.result.quiz, row.answers),
        ...b.answers,
      };
      const progress = learningProgress(row.result.quiz, answers);
      tx.set("learning", id, { ...row, answers, passed: progress.passed });
      return { answers, results: progress.results, progress };
    });
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
      "supportTickets",
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
      "reminderRefresh",
      "doseLogs",
      "doseCorrections",
      "cabinet",
      "chats",
      "learning",
      "generated",
      "devices",
      "invites",
      "inviteAttempts",
      "supportTickets",
      "supportLimits",
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
