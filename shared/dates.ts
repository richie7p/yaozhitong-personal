const taipeiCalendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function taipeiDay(now: Date | number = Date.now()): string {
  const parts = taipeiCalendar.formatToParts(now);
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export type CabinetExpiryStatus = "disposed" | "expired" | "stored";

export function cabinetExpiryStatus(
  item: { expiresAt?: string | null; disposed: boolean },
  today = taipeiDay(),
): CabinetExpiryStatus {
  if (item.disposed) return "disposed";
  return item.expiresAt && item.expiresAt < today ? "expired" : "stored";
}
