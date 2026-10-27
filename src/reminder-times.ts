export type ReminderTimesResult =
  { times: string[]; error?: never } | { times?: never; error: string };

/** Validate only the clock times explicitly entered by the user. */
export function parseReminderTimes(input: string): ReminderTimesResult {
  const entries = input
    .trim()
    .split(/[,，、\s]+/)
    .filter(Boolean);
  if (!entries.length)
    return { error: "請至少填寫一個提醒時間，例如：08:00。" };

  const times: string[] = [];
  for (const entry of entries) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(entry))
      return {
        error:
          "提醒時間請用 24 小時制，範圍為 00:00～23:59。例如早上 8 點填 08:00，晚上 8 點填 20:00。",
      };
    const normalized = entry.padStart(5, "0");
    if (times.includes(normalized))
      return {
        error: `提醒時間 ${normalized} 重複了，請只保留一次。`,
      };
    times.push(normalized);
  }
  if (times.length > 8)
    return { error: "每天最多可設定 8 個提醒時間，請依藥袋用法確認後再填寫。" };
  return { times };
}
