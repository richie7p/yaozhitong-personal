import { z } from "zod";
import type { Leaflet } from "../shared/schema.js";
import type {
  LeafletPage,
  LeafletStats,
  LeafletSummary,
} from "../shared/admin.js";
import type { Store } from "./store.js";
import { fail } from "./config.js";

const fields = ["licenseNo", "version", "sourceUrl", "status", "checkedAt"];
const idSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((id) => !id.includes("/") && id !== "." && id !== "..");
const querySchema = z.object({
  status: z.enum(["draft", "published", "retired"]).optional(),
  licenseNo: z.string().trim().max(80).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Lists metadata only. Full source chunks are fetched for one selected record. */
export class AdminLeaflets {
  constructor(private store: Store) {}
  async page(input: Record<string, string | undefined>): Promise<LeafletPage> {
    const query = querySchema.parse(input);
    const status = query.status || "",
      licenseNo = query.licenseNo || "";
    let after: string | undefined;
    if (query.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw Error();
        const cursor = z
          .object({
            v: z.literal(1),
            id: idSchema,
            status: z.string(),
            licenseNo: z.string(),
          })
          .strict()
          .parse(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
          );
        if (cursor.status !== status || cursor.licenseNo !== licenseNo)
          throw Error();
        after = cursor.id;
      } catch {
        return fail(
          "invalid_cursor",
          "清單條件已改變或頁碼失效，請回到第一頁。",
          400,
        );
      }
    }
    const where: Array<[string, unknown]> = [];
    if (status) where.push(["status", status]);
    if (licenseNo) where.push(["licenseNo", licenseNo]);
    const rows = await this.store.page<LeafletSummary>("leaflets", {
      limit: query.limit + 1,
      after,
      where,
      fields,
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const nextCursor = hasMore
      ? Buffer.from(
          JSON.stringify({ v: 1, id: items.at(-1)!.id, status, licenseNo }),
        ).toString("base64url")
      : null;
    return { items, nextCursor, hasMore, pageSize: query.limit };
  }
  async stats(): Promise<LeafletStats> {
    const [total, published, draft, retired] = await Promise.all([
      this.store.count("leaflets"),
      this.store.count("leaflets", [["status", "published"]]),
      this.store.count("leaflets", [["status", "draft"]]),
      this.store.count("leaflets", [["status", "retired"]]),
    ]);
    return { total, published, draft, retired };
  }
  async detail(id: string): Promise<Leaflet> {
    idSchema.parse(id);
    const row = await this.store.get<Leaflet>("leaflets", id);
    if (!row) return fail("not_found", "找不到這份仿單，請重新整理清單。", 404);
    return row;
  }
}
