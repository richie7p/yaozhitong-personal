import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Account } from "../shared/schema.js";
import { fail } from "./config.js";
import type { Store } from "./store.js";
const input = z
  .object({
    category: z.enum(["bug", "account", "privacy", "other"]),
    message: z.string().trim().min(10).max(1200),
  })
  .strict();
const change = z
  .object({
    message: z.string().trim().min(1).max(1200),
    status: z.enum(["open", "resolved"]),
  })
  .strict();
export interface SupportTicket {
  id: string;
  ownerId: string;
  category: string;
  message: string;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  replies: {
    message: string;
    at: string;
    operationHash?: string;
    requestedStatus?: "open" | "resolved";
  }[];
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class Support {
  constructor(private store: Store) {}
  async page(cursor = "", ownerId?: string) {
    if (!this.store.recent)
      return fail("support_unavailable", "回報管理暫時無法載入。", 503);
    let before: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        if (cursor.length > 256) throw Error();
        before = z
          .object({
            createdAt: z.string().datetime(),
            id: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      } catch {
        return fail("invalid_cursor", "頁面識別碼已失效，請返回最新回報。");
      }
    }
    const items = await this.store.recent<SupportTicket>(
      "supportTickets",
      50,
      before,
      ownerId,
    );
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        items.length === 50 && last
          ? Buffer.from(
              JSON.stringify({ createdAt: last.createdAt, id: last.id }),
            ).toString("base64url")
          : "",
    };
  }
  async create(uid: string, key: string, value: unknown) {
    const body = input.parse(value);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(key))
      return fail("invalid_request", "缺少回報識別碼，請重新送出。");
    const id = digest(uid + ":" + key),
      stamp = new Date().toISOString(),
      day = DateTime.fromISO(stamp).setZone("Asia/Taipei").toISODate()!;
    return this.store.transaction(async (tx) => {
      const account = await tx.get<Account>("users", uid);
      const existing = await tx.get<SupportTicket>("supportTickets", id);
      const limit = await tx.get("supportLimits", uid);
      if (!account || account.disabled || account.deleting)
        return fail("account_disabled", "帳號已停用。", 403);
      if (existing) {
        if (
          existing.category !== body.category ||
          existing.message !== body.message
        )
          return fail(
            "idempotency_conflict",
            "回報內容已變更，請重新送出。",
            409,
          );
        return existing;
      }
      if (
        (limit?.day === day && limit.count >= 5) ||
        Date.now() - (limit?.lastAt || 0) < 60000
      )
        return fail(
          "support_rate_limit",
          "請稍後再送出回報；每天最多 5 則。",
          429,
        );
      const ticket: SupportTicket = {
        id,
        ownerId: uid,
        ...body,
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
        replies: [],
      };
      tx.set("supportLimits", uid, {
        id: uid,
        ownerId: uid,
        day,
        count: limit?.day === day ? limit.count + 1 : 1,
        lastAt: Date.now(),
      });
      tx.set("supportTickets", id, ticket);
      return ticket;
    });
  }
  async reply(actor: string, id: string, value: unknown, key: string) {
    const body = change.parse(value);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(key))
      return fail("invalid_request", "缺少回覆識別碼，請重新送出。");
    const operationHash = digest(actor + ":" + key);
    return this.store.transaction(async (tx) => {
      const admin = await tx.get<Account>("users", actor);
      const ticket = await tx.get<SupportTicket>("supportTickets", id);
      if (!admin?.admin || admin.disabled || admin.deleting)
        return fail("forbidden", "需要管理員權限。", 403);
      if (!ticket) return fail("not_found", "找不到回報。", 404);
      const owner = await tx.get<Account>("users", ticket.ownerId);
      if (!owner || owner.deleting)
        return fail("not_found", "此回報已無法回覆。", 404);
      const repeated = ticket.replies.find(
        (reply) => reply.operationHash === operationHash,
      );
      if (repeated) {
        if (
          repeated.message !== body.message ||
          repeated.requestedStatus !== body.status
        )
          return fail(
            "idempotency_conflict",
            "回覆內容已變更，請重新送出。",
            409,
          );
        return ticket;
      }
      if (ticket.replies.length >= 20)
        return fail(
          "support_reply_limit",
          "此回報的回覆已達上限，請另開回報。",
          409,
        );
      const at = new Date().toISOString();
      const next = {
        ...ticket,
        status: body.status,
        updatedAt: at,
        replies: [
          ...ticket.replies,
          {
            message: body.message,
            at,
            operationHash,
            requestedStatus: body.status,
          },
        ],
      };
      tx.set("supportTickets", id, next);
      return next;
    });
  }
}
