import { randomUUID } from "node:crypto";
import { getMessaging } from "firebase-admin/messaging";
import type { Schedule, Medication, Account } from "../shared/schema.js";
import { config } from "./config.js";
import { firebaseApp } from "./store.js";
import { Domain, hash, nextTime, now } from "./domain.js";
import { localWorkerAlive } from "./local-runner.js";
import { ensureReminderIndex, refreshReminders } from "./reminder-state.js";
import {
  dueFamilyOccurrences,
  dueOwnerOccurrences,
  FAMILY_DELAY_MS,
  familyDayStart,
  nextFamilyTime,
  scheduledAt,
} from "./schedule-time.js";
import type { Doc } from "./store.js";
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
  if (await ensureReminderIndex(d.store, clock)) {
    await refreshReminders(d.store, clock);
    for (const s of await d.store.queryDue<Schedule>(
      "schedules",
      "nextAt",
      timestamp,
      ["active", true],
    )) {
      const dueAt = s.nextAt;
      await d.store.transaction(async (tx) => {
        const current = await tx.get<Schedule>("schedules", s.id);
        if (
          !current?.active ||
          current.nextAt !== dueAt ||
          current.reminderVersion !== s.reminderVersion ||
          !dueAt
        )
          return;
        const owner = await tx.get<Account>("users", current.ownerId);
        const med = await tx.get<Medication>(
          "medications",
          current.medicationId,
        );
        if (!validMedication(current, med) || !enabled(owner)) {
          tx.set("schedules", current.id, {
            ...current,
            active: current.active && validMedication(current, med),
            nextAt: null,
            nextFamilyAt: null,
          });
          return;
        }
        const pending: Doc[] = [];
        for (const occurrenceAt of dueOwnerOccurrences(current, clock)) {
          const occurrence = hash(
            current.id + "|" + current.medicationRevision + "|" + occurrenceAt,
          );
          const notificationId = hash(occurrence + "|owner");
          if (await tx.get("notifications", notificationId)) continue;
          pending.push({
            id: notificationId,
            ownerId: current.ownerId,
            scheduleId: current.id,
            medicationId: med!.id,
            medicationRevision: med!.revision,
            occurrenceId: occurrence,
            dueAt: occurrenceAt,
            status: "pending",
            leaseUntil: 0,
            message: "用藥時間到了，請開啟藥智通查看並記錄。",
            createdAt: timestamp,
          });
        }
        for (const n of pending) tx.set("notifications", n.id, n);
        tx.set("schedules", current.id, {
          ...current,
          nextAt: nextTime(current, timestamp),
        });
      });
    }
    for (const s of await d.store.queryDue<Schedule>(
      "schedules",
      "nextFamilyAt",
      timestamp,
      ["active", true],
    )) {
      const rels = (
        await d.store.list("relationships", ["ownerId", s.ownerId])
      ).filter((r) => r.active);
      await d.store.transaction(async (tx) => {
        const current = await tx.get<Schedule>("schedules", s.id);
        if (
          !current?.active ||
          current.nextFamilyAt !== s.nextFamilyAt ||
          current.reminderVersion !== s.reminderVersion
        )
          return;
        const owner = await tx.get<Account>("users", current.ownerId);
        const med = await tx.get<Medication>(
          "medications",
          current.medicationId,
        );
        const profile = await tx.get("profiles", current.ownerId);
        const valid = validMedication(current, med) && enabled(owner);
        const recipients: Doc[] = [];
        const pending: Doc[] = [];
        if (valid && profile?.notifyFamily) {
          for (const candidate of rels) {
            const r = await tx.get("relationships", candidate.id);
            if (r?.active && r.ownerId === current.ownerId) recipients.push(r);
          }
          for (const dueAt of dueFamilyOccurrences(current, clock)) {
            const occurrenceId = hash(
              current.id + "|" + current.medicationRevision + "|" + dueAt,
            );
            if (await tx.get("doseLogs", occurrenceId)) continue;
            for (const r of recipients) {
              const id = hash(occurrenceId + "|family|" + r.caregiverId);
              if (await tx.get("notifications", id)) continue;
              pending.push({
                id,
                ownerId: r.caregiverId,
                recipientId: current.ownerId,
                relationshipId: r.id,
                scheduleId: current.id,
                occurrenceId,
                medicationId: current.medicationId,
                medicationRevision: current.medicationRevision,
                dueAt,
                status: "pending",
                leaseUntil: 0,
                message:
                  "家人的用藥時段已過，目前尚未記錄，您可以開啟藥智通查看。",
                createdAt: timestamp,
              });
            }
          }
        }
        // All reads precede writes. Creation and checkpoint advancement commit
        // together, so a retry/crash never drops the family check.
        for (const n of pending) tx.set("notifications", n.id, n);
        tx.set("schedules", current.id, {
          ...current,
          active: current.active && validMedication(current, med),
          nextAt: valid ? current.nextAt : null,
          nextFamilyAt:
            valid && profile?.notifyFamily && recipients.length
              ? nextFamilyTime(current, timestamp)
              : null,
        });
      });
    }
  }
  for (const n of await d.store.queryDue(
    "notifications",
    "leaseUntil",
    clock.getTime(),
    ["status", "pending"],
  )) {
    const sourceUid = n.recipientId || n.ownerId;
    // Only legacy pending notifications need the owner-scoped compatibility
    // lookup. New reminders validate one schedule, not the entire day's data.
    const scheduleId =
      n.scheduleId ||
      (n.dueAt &&
        (
          await d.store.list<Schedule>("schedules", ["ownerId", sourceUid])
        ).find(
          (s) =>
            hash(s.id + "|" + s.medicationRevision + "|" + n.dueAt) ===
            n.occurrenceId,
        )?.id);
    const deliveryToken = randomUUID();
    const claimed = await d.store.transaction(async (tx) => {
      const current = await tx.get("notifications", n.id);
      if (
        !current ||
        current.status !== "pending" ||
        current.leaseUntil > clock.getTime()
      )
        return null;
      const s = scheduleId
        ? await tx.get<Schedule>("schedules", scheduleId)
        : null;
      const owner = await tx.get<Account>("users", sourceUid);
      const target =
        sourceUid === current.ownerId
          ? owner
          : await tx.get<Account>("users", current.ownerId);
      const m = await tx.get<Medication>("medications", current.medicationId);
      const r = current.relationshipId
        ? await tx.get("relationships", current.relationshipId)
        : null;
      const profile = current.relationshipId
        ? await tx.get("profiles", sourceUid)
        : null;
      const log = current.occurrenceId
        ? await tx.get("doseLogs", current.occurrenceId)
        : null;
      const validOccurrence =
        s &&
        current.dueAt &&
        s.ownerId === sourceUid &&
        validMedication(s, m) &&
        m!.revision === current.medicationRevision &&
        scheduledAt(s, current.dueAt) &&
        hash(s.id + "|" + s.medicationRevision + "|" + current.dueAt) ===
          current.occurrenceId;
      const expired =
        !current.dueAt ||
        (current.relationshipId
          ? Date.parse(current.dueAt) + FAMILY_DELAY_MS <=
            Date.parse(familyDayStart(clock))
          : clock.getTime() - Date.parse(current.dueAt) >= FAMILY_DELAY_MS);
      if (
        !enabled(owner) ||
        !enabled(target) ||
        !validOccurrence ||
        log ||
        expired ||
        (current.relationshipId &&
          (!r?.active ||
            r.ownerId !== sourceUid ||
            r.caregiverId !== current.ownerId ||
            !profile?.notifyFamily))
      ) {
        tx.set("notifications", current.id, {
          ...current,
          status: "cancelled",
          leaseUntil: 0,
        });
        return null;
      }
      tx.set("notifications", n.id, {
        ...current,
        scheduleId,
        deliveryToken,
        leaseUntil: clock.getTime() + 120000,
      });
      return current;
    });
    if (!claimed) continue;
    let delivered = false;
    try {
      await send(claimed.ownerId, claimed.id, claimed.message);
      delivered = true;
    } catch {
      /* Retry after the persisted backoff, without holding the tick. */
    }
    await d.store.transaction(async (tx) => {
      const current = await tx.get("notifications", n.id);
      if (
        current?.status !== "pending" ||
        current.deliveryToken !== deliveryToken
      )
        return;
      tx.set("notifications", current.id, {
        ...current,
        ...(delivered
          ? { status: "sent", sentAt: now(), leaseUntil: 0 }
          : { leaseUntil: clock.getTime() + 60000 }),
      });
    });
  }
  // A dead local worker cannot finish its job. Release its lease immediately
  // after a crash instead of making a restarted demo wait up to nine minutes.
  // Do not reclaim another live process's work or infer ownership of old jobs.
  if (config.mode === "local")
    for (const job of await d.store.list("jobs", ["status", "running"])) {
      if (
        !job.localWorkerPid ||
        localWorkerAlive(job.localWorkerPid, job.localWorkerBootTime)
      )
        continue;
      await d.store.transaction(async (tx) => {
        const current = await tx.get("jobs", job.id);
        if (
          current?.status === "running" &&
          current.localWorkerPid === job.localWorkerPid &&
          current.localWorkerBootTime === job.localWorkerBootTime &&
          current.attempts === job.attempts
        )
          tx.set("jobs", job.id, { ...current, leaseUntil: 0 });
      });
    }
  // Recover tasks whose queue dispatch failed or whose worker lease expired.
  for (const job of [
    ...(await d.store.list("jobs", ["status", "queued"])),
    ...(await d.store.queryDue("jobs", "leaseUntil", clock.getTime(), [
      "status",
      "running",
    ])),
  ])
    if (
      (job.status === "queued" ||
        (job.status === "running" && job.leaseUntil <= clock.getTime())) &&
      d.enqueue
    )
      await d.enqueue(job.id).catch(() => {});
  return { checkedAt: timestamp };
}

function enabled(owner: Account | null): boolean {
  return !!owner && !owner.disabled && !owner.deleting;
}

function validMedication(s: Schedule, m: Medication | null): boolean {
  return (
    !!m &&
    m.id === s.medicationId &&
    m.ownerId === s.ownerId &&
    !m.archived &&
    m.confirmed &&
    !m.prn &&
    m.revision === s.medicationRevision
  );
}
