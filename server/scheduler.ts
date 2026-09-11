import { DateTime } from "luxon";
import { getMessaging } from "firebase-admin/messaging";
import type { Schedule, Medication, Account } from "../shared/schema.js";
import { config } from "./config.js";
import { firebaseApp } from "./store.js";
import { Domain, hash, nextTime, now } from "./domain.js";
export type Sender = (
  uid: string,
  id: string,
  message: string,
) => Promise<void>;
export function messagingSender(d: Domain): Sender {
  return async (uid, id, message) => {
    if (config.mode === "local") return;
    const devices = await d.store.list("devices", ["ownerId", uid]);
    for (const device of devices) {
      try {
        await getMessaging(firebaseApp()).send({
          token: device.token,
          notification: { title: "藥智通提醒", body: message },
          webpush: {
            headers: { TTL: "3600" },
            notification: { tag: id },
            fcmOptions: { link: config.appUrl + "/#home" },
          },
        });
      } catch (e: any) {
        if (
          [
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token",
          ].includes(e.code)
        )
          await d.store.delete("devices", device.id);
        else throw e;
      }
    }
  };
}
export async function tick(
  d: Domain,
  clock = new Date(),
  send: Sender = messagingSender(d),
) {
  const timestamp = clock.toISOString();
  const today = DateTime.fromJSDate(clock).setZone("Asia/Taipei").toISODate()!;
  const dayCache = new Map<string, Awaited<ReturnType<Domain["today"]>>>();
  const occurrences = async (uid: string, date: string) => {
    const key = uid + "|" + date;
    if (!dayCache.has(key)) dayCache.set(key, await d.today(uid, date));
    return dayCache.get(key)!;
  };
  for (const s of await d.store.list<Schedule>("schedules", ["active", true])) {
    const owner = await d.store.get<Account>("users", s.ownerId);
    if (!owner || owner.disabled || owner.deleting) continue;
    const med = await d.store.get<Medication>("medications", s.medicationId);
    if (
      !med ||
      med.archived ||
      !med.confirmed ||
      med.revision !== s.medicationRevision
    )
      continue;
    if (s.nextAt && s.nextAt <= timestamp) {
      const dueAt = s.nextAt;
      const occurrence = hash(s.id + "|" + s.medicationRevision + "|" + dueAt);
      const notificationId = hash(occurrence + "|owner");
      await d.store.transaction(async (tx) => {
        const current = await tx.get<Schedule>("schedules", s.id);
        const existing = await tx.get("notifications", notificationId);
        if (!current?.active || current.nextAt !== dueAt) return;
        if (!existing && clock.getTime() - Date.parse(dueAt) < 3600000)
          tx.set("notifications", notificationId, {
            id: notificationId,
            ownerId: s.ownerId,
            medicationId: med.id,
            medicationRevision: med.revision,
            occurrenceId: occurrence,
            dueAt,
            status: "pending",
            leaseUntil: 0,
            message: "用藥時間到了，請開啟藥智通查看並記錄。",
            createdAt: timestamp,
          });
        tx.set("schedules", s.id, {
          ...current,
          nextAt: nextTime(current, timestamp),
        });
      });
    }
    if (s.startDate > today || (s.endDate && s.endDate < today)) continue;
    const profile = await d.store.get("profiles", s.ownerId);
    if (!profile?.notifyFamily) continue;
    for (const row of await occurrences(s.ownerId, today)) {
      if (
        row.medicationId !== med.id ||
        row.log ||
        Date.parse(row.dueAt) > clock.getTime() - 3600000
      )
        continue;
      const rels = (
        await d.store.list("relationships", ["ownerId", s.ownerId])
      ).filter((r) => r.active);
      for (const r of rels) {
        const id = hash(row.id + "|family|" + r.caregiverId);
        await d.store.transaction(async (tx) => {
          if (await tx.get("notifications", id)) return;
          tx.set("notifications", id, {
            id,
            ownerId: r.caregiverId,
            recipientId: s.ownerId,
            relationshipId: r.id,
            occurrenceId: row.id,
            medicationId: med.id,
            medicationRevision: med.revision,
            dueAt: row.dueAt,
            status: "pending",
            leaseUntil: 0,
            message: "家人的用藥時段已過，目前尚未記錄，您可以開啟藥智通查看。",
            createdAt: timestamp,
          });
        });
      }
    }
  }
  for (const n of await d.store.list("notifications", ["status", "pending"])) {
    if (n.leaseUntil > clock.getTime()) continue;
    const target = await d.store.get<Account>("users", n.ownerId);
    const m = await d.store.get<Medication>("medications", n.medicationId);
    const r = n.relationshipId
      ? await d.store.get("relationships", n.relationshipId)
      : null;
    const sourceUid = n.recipientId || n.ownerId;
    const sourceOwner = await d.store.get<Account>("users", sourceUid);
    const sourceProfile = n.relationshipId
      ? await d.store.get("profiles", sourceUid)
      : null;
    const occurrenceDate = n.dueAt
      ? DateTime.fromISO(n.dueAt).setZone("Asia/Taipei").toISODate()
      : null;
    const stillScheduled =
      occurrenceDate &&
      (await occurrences(sourceUid, occurrenceDate)).some(
        (row) => row.id === n.occurrenceId,
      );
    if (
      !target ||
      target.disabled ||
      target.deleting ||
      !sourceOwner ||
      sourceOwner.disabled ||
      sourceOwner.deleting ||
      !stillScheduled ||
      (n.occurrenceId && (await d.store.get("doseLogs", n.occurrenceId))) ||
      !m ||
      m.archived ||
      m.revision !== n.medicationRevision ||
      (n.relationshipId && (!r?.active || !sourceProfile?.notifyFamily))
    ) {
      await d.store.set("notifications", n.id, { ...n, status: "cancelled" });
      continue;
    }
    const claimed = await d.store.transaction(async (tx) => {
      const current = await tx.get("notifications", n.id);
      if (
        !current ||
        current.status !== "pending" ||
        current.leaseUntil > clock.getTime()
      )
        return false;
      tx.set("notifications", n.id, {
        ...current,
        leaseUntil: clock.getTime() + 120000,
      });
      return true;
    });
    if (!claimed) continue;
    try {
      await send(n.ownerId, n.id, n.message);
      await d.store.set("notifications", n.id, {
        ...n,
        status: "sent",
        sentAt: now(),
        leaseUntil: 0,
      });
    } catch {
      await d.store.set("notifications", n.id, {
        ...n,
        leaseUntil: clock.getTime() + 60000,
      });
    }
  }
  // Recover tasks whose queue dispatch failed or whose worker lease expired.
  for (const job of [
    ...(await d.store.list("jobs", ["status", "queued"])),
    ...(await d.store.list("jobs", ["status", "running"])),
  ])
    if (
      (job.status === "queued" ||
        (job.status === "running" && job.leaseUntil < clock.getTime())) &&
      d.enqueue
    )
      await d.enqueue(job.id).catch(() => {});
  return { checkedAt: timestamp };
}
