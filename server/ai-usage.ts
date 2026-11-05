import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { AiUsage } from "../shared/ai-usage.js";
import type { Store } from "./store.js";

/** Reads the same daily counters used by job admission; never reserves a use. */
export async function readAiUsage(
  store: Pick<Store, "get">,
  uid: string,
  limits: { userLimit: number; globalLimit: number },
  access: AiUsage["access"],
  at: DateTime = DateTime.now(),
): Promise<AiUsage> {
  const taipei = at.setZone("Asia/Taipei");
  const date = taipei.toISODate()!;
  const userKey = createHash("sha256")
    .update(uid + "|" + date)
    .digest("hex");
  const [user, global] = await Promise.all([
    store.get("usage", userKey),
    store.get("usage", "global-" + date),
  ]);
  const count = (used: number | undefined, limit: number) => ({
    used: used || 0,
    limit,
    remaining: Math.max(0, limit - (used || 0)),
  });
  const personal = count(user?.count, limits.userLimit);
  const shared = count(global?.count, limits.globalLimit);
  return {
    date,
    timezone: "Asia/Taipei",
    resetsAt: taipei.plus({ days: 1 }).startOf("day").toISO()!,
    checkedAt: taipei.toISO()!,
    personal,
    global: shared,
    available: Math.min(personal.remaining, shared.remaining),
    access,
  };
}
