import { DateTime } from "luxon";
import type { Schedule } from "../shared/schema.js";
import { fail } from "./config.js";

export const FAMILY_DELAY_MS = 60 * 60 * 1000;
type Times = Pick<Schedule, "startDate" | "endDate" | "times" | "timezone">;

export function nextTime(s: Times, after: string): string | null {
  const t = DateTime.fromISO(after, { zone: s.timezone });
  const start = DateTime.fromISO(s.startDate, { zone: s.timezone });
  if (
    !t.isValid ||
    !start.isValid ||
    (s.endDate && !DateTime.fromISO(s.endDate).isValid)
  )
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

export function nextFamilyTime(s: Times, after: string): string | null {
  const due = nextTime(
    s,
    new Date(Date.parse(after) - FAMILY_DELAY_MS).toISOString(),
  );
  return due ? new Date(Date.parse(due) + FAMILY_DELAY_MS).toISOString() : null;
}

// Recover today's family-check deadlines, including a late-night dose whose
// one-hour deadline falls after midnight. Never flood users with days-old alerts.
export function familyDayStart(clock: Date): string {
  return DateTime.fromJSDate(clock)
    .setZone("Asia/Taipei")
    .startOf("day")
    .minus({ milliseconds: 1 })
    .toUTC()
    .toISO()!;
}

export function initialFamilyTime(s: Times, clock: Date): string | null {
  return nextFamilyTime(s, familyDayStart(clock));
}

export function scheduledAt(s: Schedule, dueAt: string): boolean {
  const due = DateTime.fromISO(dueAt, { zone: s.timezone });
  const date = due.toISODate();
  return !!(
    s.active &&
    date &&
    date >= s.startDate &&
    (!s.endDate || date <= s.endDate) &&
    s.times.includes(due.toFormat("HH:mm")) &&
    due.second === 0 &&
    due.millisecond === 0
  );
}

export function dueFamilyOccurrences(s: Schedule, clock: Date): string[] {
  const lower = Math.max(
    Date.parse(s.nextFamilyAt!),
    Date.parse(familyDayStart(clock)) + 1,
  );
  const rows: string[] = [];
  const today = DateTime.fromJSDate(clock).setZone(s.timezone).startOf("day");
  for (const day of [today.minus({ days: 1 }), today]) {
    for (const time of s.times) {
      const [hour, minute] = time.split(":").map(Number);
      const dueAt = day.set({ hour, minute }).toUTC().toISO()!;
      const checkAt = Date.parse(dueAt) + FAMILY_DELAY_MS;
      if (
        checkAt >= lower &&
        checkAt <= clock.getTime() &&
        scheduledAt(s, dueAt)
      )
        rows.push(dueAt);
    }
  }
  return rows;
}

export function dueOwnerOccurrences(s: Schedule, clock: Date): string[] {
  if (!s.nextAt) return [];
  const rows: string[] = [];
  const today = DateTime.fromJSDate(clock).setZone(s.timezone).startOf("day");
  for (const day of [today.minus({ days: 1 }), today]) {
    for (const time of s.times) {
      const [hour, minute] = time.split(":").map(Number);
      const dueAt = day.set({ hour, minute }).toUTC().toISO()!;
      if (
        dueAt >= s.nextAt &&
        Date.parse(dueAt) <= clock.getTime() &&
        Date.parse(dueAt) > clock.getTime() - FAMILY_DELAY_MS &&
        scheduledAt(s, dueAt)
      )
        rows.push(dueAt);
    }
  }
  return rows;
}
