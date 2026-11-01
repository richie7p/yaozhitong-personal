import type { Leaflet } from "./schema.js";

export type LeafletSummary = Pick<
  Leaflet,
  "id" | "licenseNo" | "version" | "sourceUrl" | "status" | "checkedAt"
>;
export interface LeafletStats {
  total: number;
  published: number;
  draft: number;
  retired: number;
}
export interface LeafletPage {
  items: LeafletSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
}
