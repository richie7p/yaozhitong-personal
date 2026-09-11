import type { Drug } from "../shared/schema.js";
import type { Store } from "./store.js";
import { Blobs } from "./blobs.js";
export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s「」"“”]/g, "");
export function scoreDrug(d: Drug, q: string, strength = "", form = "") {
  const n = normalize(q),
    zh = normalize(d.nameZh),
    en = normalize(d.nameEn);
  let s =
    zh === n || en === n
      ? 100
      : zh.startsWith(n) || en.startsWith(n)
        ? 60
        : zh.includes(n) || en.includes(n)
          ? 35
          : 0;
  if (d.licenseNo === q) s = 150;
  if (s === 0) return 0;
  if (strength) s += normalize(d.strength) === normalize(strength) ? 50 : -80;
  if (form) s += normalize(d.form).includes(normalize(form)) ? 30 : -80;
  if (d.revoked) s -= 20;
  return s;
}
export class Catalog {
  private version = "";
  private rows: Drug[] = [];
  private loadedAt = 0;
  constructor(
    private store: Store,
    private blobs = new Blobs(),
  ) {}
  async all() {
    if (Date.now() - this.loadedAt < 30000) return this.rows;
    const m = await this.store.get("settings", "catalog");
    if (m && m.version !== this.version) {
      this.rows = JSON.parse((await this.blobs.get(m.path)).toString());
      this.version = m.version;
    }
    this.loadedAt = Date.now();
    return this.rows;
  }
  async search(q: string, strength = "", form = "") {
    if (q.trim().length < 2) return [];
    return (await this.all())
      .map((d) => ({ ...d, score: scoreDrug(d, q, strength, form) }))
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }
  async get(lic: string) {
    return (await this.all()).find((d) => d.licenseNo === lic) || null;
  }
  invalidate() {
    this.loadedAt = 0;
  }
}
