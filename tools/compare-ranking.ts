// Ranking baseline adapted from Sean Fang's Apache-2.0 demo, commit
// 440850bc77e11419a98c1850beba5ac278d07233, server/server.mjs findCandidates.
// Candidate pools are provided by the dataset so retrieval is held constant.
import { readFile, writeFile } from "node:fs/promises";
import { scoreDrug } from "../server/catalog.js";
import type { Drug } from "../shared/schema.js";
const [input, out = "ranking-comparison.json"] = process.argv.slice(2);
if (!input)
  throw Error("Usage: tsx tools/compare-ranking.ts cases.jsonl report.json");
const cases = (await readFile(input, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((x) => JSON.parse(x));
function originalScore(d: Drug, q: string, has: boolean) {
  const half = (s: string) =>
    s
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/／/g, "/");
  const zh = half(q).trim(),
    noDose = zh
      .replace(
        /[\s\d.\/]+\s*(mg|mcg|μg|g|ml|cc|iu|%|毫克|公絲|微克|公克|毫升)?\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
  const core = (noDose.match(/^[一-鿿"“”「」]+/) || [""])[0]
    .replace(/[錠膜衣糖衣膠囊液劑散粉]+$/, "")
    .replace(/["“”「」]/g, "")
    .trim();
  const forms = [
    "膜衣錠",
    "糖衣錠",
    "錠",
    "膠囊",
    "栓劑",
    "糖漿",
    "液",
    "散",
    "粉",
    "乳膏",
    "軟膏",
    "凝膠",
    "注射",
    "滴劑",
    "噴劑",
  ];
  const form = (s: string) =>
    (forms.find((f) => s.includes(f)) || "").replace(/^(膜衣|糖衣)/, "");
  const name = half(d.nameZh).replace(/["“”「」\s]/g, "");
  let s = has ? 100 : 0;
  if (core && name.startsWith(core)) s += 20;
  if (noDose && name.includes(noDose.replace(/\s/g, ""))) s += 10;
  if (form(zh) && form(name) && form(zh) !== form(name)) s -= 60;
  if (!d.revoked) s += 5;
  return s;
}
const rows = cases.map((c) => {
  if (!c.expectedLicenseNo || !Array.isArray(c.candidatePool))
    throw Error(
      "Each case needs expectedLicenseNo and a fixed candidatePool of drug records.",
    );
  const pool = c.candidatePool as Array<Drug & { hasLeaflet: boolean }>;
  const sort = (score: (d: Drug & { hasLeaflet: boolean }) => number) =>
    pool
      .map((d) => ({ d, s: score(d) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.d.licenseNo);
  return {
    id: c.id,
    split: c.split,
    expectedLicenseNo: c.expectedLicenseNo,
    original: sort((d) => originalScore(d, c.query, d.hasLeaflet)),
    improved: sort((d) =>
      scoreDrug(d, c.query, c.strength || "", c.form || ""),
    ),
  };
});
const metrics = (key: "original" | "improved") => ({
  top1: rows.length
    ? rows.filter((r) => r[key][0] === r.expectedLicenseNo).length / rows.length
    : null,
  top3: rows.length
    ? rows.filter((r) => r[key].slice(0, 3).includes(r.expectedLicenseNo))
        .length / rows.length
    : null,
});
const report = {
  cases: rows.length,
  original: metrics("original"),
  improved: metrics("improved"),
  rows,
  limitation:
    "固定候選池的排序比較；不重現原版 Neon 檢索，也不代表真實藥袋辨識準確率。",
};
await writeFile(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    cases: report.cases,
    original: report.original,
    improved: report.improved,
  }),
);
