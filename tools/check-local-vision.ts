/** Development-only challenges, separate from the preserved evaluation holdout. */
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Nvidia, recognize } from "../server/ai.js";
import { config } from "../server/config.js";
const dir = ".local/reports/vision-challenges";
await mkdir(dir, { recursive: true });
const medicine = (strength = "5mg", missing = false) => ({
  name: `開發測試片 ${strength}`,
  strength,
  doseAmount: missing ? null : 0.5,
  doseUnit: missing ? null : "錠",
  frequencyRaw: missing ? null : "BID PC",
  route: "口服",
  durationDays: 7,
});
const cases = [
  { id: "clear", medicines: [medicine()], style: "" },
  { id: "blur", medicines: [medicine()], style: "filter:blur(2px)" },
  { id: "dim", medicines: [medicine()], style: "filter:brightness(.45)" },
  { id: "glare", medicines: [medicine()], style: "", glare: true },
  {
    id: "missing-dose-frequency",
    medicines: [medicine("5mg", true)],
    style: "",
  },
  { id: "different-strength", medicines: [medicine("10mg")], style: "" },
  {
    id: "two-strengths",
    medicines: [medicine("5mg"), medicine("10mg", true)],
    style: "",
  },
];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 780 },
  });
  for (const c of cases) {
    await page.setContent(
      `<html lang="zh-Hant"><meta charset="utf-8"><style>body{margin:0;padding:30px;background:#ccd3cf;font:25px Arial}.bag{position:relative;background:#fff;padding:22px;margin-bottom:16px;border:1px solid #222;${c.style}}h2{margin:12px 0}.glare{position:absolute;inset:0;background:linear-gradient(110deg,transparent 25%,#ffffffbb 47%,transparent 66%)}</style>${c.medicines.map((m) => `<div class="bag"><small>合成藥袋／非處方／沒有真實患者</small><h2>${m.name}</h2><p>每次劑量：${m.doseAmount === null ? "" : "0.5 錠"}　頻次：${m.frequencyRaw || ""}</p><p>途徑：口服　天數：7</p>${c.glare ? '<div class="glare"></div>' : ""}</div>`).join("")}</html>`,
    );
    await page.screenshot({ path: `${dir}/${c.id}.png` });
  }
} finally {
  await browser.close();
}
const results: any[] = [];
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const requested = process.argv.slice(2);
if (requested.some((id) => !cases.some((c) => c.id === id)))
  throw Error("Unknown development fixture");
for (const c of cases.filter(
  (c) => !requested.length || requested.includes(c.id),
)) {
  const llm = new Nvidia(),
    start = Date.now();
  let raw: unknown;
  const generate = llm.json.bind(llm);
  llm.json = async (...args) => {
    raw = await generate(...args);
    return raw;
  };
  try {
    const output = await recognize(
      llm,
      await readFile(`${dir}/${c.id}.png`),
      "image/png",
    );
    const comparisons = c.medicines.map((expected) => {
      // Name/strength may be returned separately. Match rows on both components;
      // retain the strict name comparison instead of hiding representation differences.
      const actual = output.medications.find(
        (m) =>
          m.strength === expected.strength &&
          m.name.replace(expected.strength, "").trim() ===
            expected.name.replace(expected.strength, "").trim(),
      );
      return {
        name: expected.name,
        fields: Object.fromEntries(
          Object.entries(expected).map(([key, value]) => [
            key,
            {
              expected: value,
              actual: (actual as any)?.[key] ?? null,
              match:
                key === "name"
                  ? !!actual
                  : !!actual && value === ((actual as any)?.[key] ?? null),
              strictMatch:
                !!actual && value === ((actual as any)?.[key] ?? null),
            },
          ]),
        ),
      };
    });
    const passed =
      output.status === "succeeded" &&
      output.medications.length === c.medicines.length &&
      comparisons.every((c) => Object.values(c.fields).every((f) => f.match));
    results.push({
      id: c.id,
      passed,
      output,
      comparisons,
      latencyMs: Date.now() - start,
      tokens: llm.tokens,
    });
  } catch (e: any) {
    results.push({
      id: c.id,
      passed: false,
      code: e.code || "error",
      rawSyntheticOutput: raw,
      latencyMs: Date.now() - start,
      tokens: llm.tokens,
    });
  }
  await writeFile(
    `${dir}/results-${runId}.json`,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model: config.visionModel,
        synthetic: true,
        split: "development-new",
        scoring:
          "藥名與含量允許分欄，其餘欄位逐字／數值比對；保留 strictMatch。",
        limitation:
          "七張合成開發案例，不代表真實藥袋準確率，未使用保留測試集。",
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      id: c.id,
      passed: results.at(-1).passed,
      latencyMs: results.at(-1).latencyMs,
      tokens: llm.tokens,
    }),
  );
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
