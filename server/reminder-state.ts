import { randomUUID } from "node:crypto";
import type { Schedule, Account } from "../shared/schema.js";
import type { Store, Tx } from "./store.js";
import { initialFamilyTime, nextTime } from "./schedule-time.js";

const MIGRATION = "reminder-due-v1";

export function requestReminderRefresh(tx: Tx, uid: string) {
  tx.set("reminderRefresh", uid, {
    id: uid,
    ownerId: uid,
    version: randomUUID(),
  });
}

// Persist the migration marker across cold starts. A crashed migration is
// resumable: only unversioned schedules are changed, and the claim expires.
export async function ensureReminderIndex(store: Store, clock: Date) {
  if ((await store.get("settings", MIGRATION))?.ready) return true;
  const token = randomUUID();
  const claimed = await store.transaction(async (tx) => {
    const state = await tx.get("settings", MIGRATION);
    if (state?.ready) return "ready";
    if (state?.leaseUntil > clock.getTime()) return "busy";
    tx.set("settings", MIGRATION, {
      token,
      leaseUntil: clock.getTime() + 300000,
    });
    return "claimed";
  });
  if (claimed !== "claimed") return claimed === "ready";
  try {
    for (const row of await store.list<Schedule>("schedules", [
      "active",
      true,
    ])) {
      if (row.reminderSchemaVersion === 1) continue;
      await store.transaction(async (tx) => {
        const current = await tx.get<Schedule>("schedules", row.id);
        if (!current?.active || current.reminderSchemaVersion === 1) return;
        tx.set("schedules", row.id, {
          ...current,
          reminderSchemaVersion: 1,
          reminderVersion: randomUUID(),
          nextFamilyAt: initialFamilyTime(current, clock),
        });
      });
    }
    return await store.transaction(async (tx) => {
      const state = await tx.get("settings", MIGRATION);
      if (state?.token !== token) return !!state?.ready;
      tx.set("settings", MIGRATION, {
        ready: true,
        completedAt: clock.toISOString(),
      });
      return true;
    });
  } catch (error) {
    await store.transaction(async (tx) => {
      if ((await tx.get("settings", MIGRATION))?.token === token)
        tx.delete("settings", MIGRATION);
    });
    throw error;
  }
}

// Consent/account/relationship changes enqueue a durable owner refresh in the
// same transaction as the change. A crash never loses the need to re-arm.
export async function refreshReminders(store: Store, clock: Date) {
  for (const request of await store.list("reminderRefresh")) {
    for (const row of await store.list<Schedule>("schedules", [
      "ownerId",
      request.ownerId,
    ])) {
      await store.transaction(async (tx) => {
        const pending = await tx.get("reminderRefresh", request.id);
        const s = await tx.get<Schedule>("schedules", row.id);
        if (pending?.version !== request.version || !s?.active) return;
        const owner = await tx.get<Account>("users", s.ownerId);
        const profile = await tx.get("profiles", s.ownerId);
        const enabled = owner && !owner.disabled && !owner.deleting;
        tx.set("schedules", s.id, {
          ...s,
          reminderSchemaVersion: 1,
          reminderVersion: randomUUID(),
          nextAt: enabled ? s.nextAt || nextTime(s, clock.toISOString()) : null,
          nextFamilyAt:
            enabled && profile?.notifyFamily
              ? initialFamilyTime(s, clock)
              : null,
        });
      });
    }
    await store.transaction(async (tx) => {
      if (
        (await tx.get("reminderRefresh", request.id))?.version ===
        request.version
      )
        tx.delete("reminderRefresh", request.id);
    });
  }
}
