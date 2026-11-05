import type { AiUsage } from "../../shared/ai-usage";

/** Synthetic counters for browser fixtures that prohibit backend requests. */
export function syntheticAiUsage(used = 0, globalUsed = used): AiUsage {
  const checkedAt = new Date();
  const taipeiDate = new Date(checkedAt.getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  const resetsAt = new Date(
    Date.parse(taipeiDate + "T00:00:00+08:00") + 86400000,
  ).toISOString();
  return {
    date: taipeiDate,
    timezone: "Asia/Taipei",
    checkedAt: checkedAt.toISOString(),
    resetsAt,
    personal: { used, limit: 30, remaining: Math.max(0, 30 - used) },
    global: {
      used: globalUsed,
      limit: 2000,
      remaining: Math.max(0, 2000 - globalUsed),
    },
    available: Math.max(0, Math.min(30 - used, 2000 - globalUsed)),
    access: "ready",
  };
}
