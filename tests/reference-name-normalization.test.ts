import { expect, it, vi } from "vitest";
import { relevantReferenceText, referenceSearchRequest } from "../server/reference-search";
import { readReferenceContent } from "../server/reference-content";
import type { Drug } from "../shared/schema";
import type { ReferenceSearch } from "../shared/assistance";

const product = (name: string, form = "眼藥膏"): Drug => ({
  licenseNo: "", nameZh: name, nameEn: "", ingredients: [],
  strength: "", form, revoked: false,
});
const search: ReferenceSearch = {
  state: "found", passages: [],
  sources: [{ id: "source", title: "Synthetic reference", kind: "hospital", url: "https://www.cth.org.tw/synthetic" }],
};
const body = "Software fixture only; this is not medical information. Preserve the complete original condition. ".repeat(3);
const original = (heading: string) => vi.fn(async () => new Response(
  `<main><h1>${heading}</h1><p>${body}</p></main>`,
  { headers: { "content-type": "text/html" } },
));

it.each([
  "合成鹽酸四環素 眼用軟膏",
  "合成鹽酸四環素眼用軟膏 1%",
  "合成鹽酸四環素 １％ 眼藥膏",
  "合成鹽酸四環素 10 mg/g 眼用軟膏",
])("can read the same literal name when the query includes form/strength suffixes: %s", async (name) => {
  const query = product(name);
  const result = await readReferenceContent(search, [query], {
    fetcher: original("合成鹽酸四環素眼藥膏"),
  });
  expect(result.state).toBe("found");
  expect(result.passages[0].text).toContain(body.trim());
  // Relevance aliases neither confirm a product nor change the search input.
  expect(query.nameZh).toBe(name);
  expect(query.ingredients).toEqual([]);
  expect(JSON.parse(referenceSearchRequest([query], "synthetic").input).products[0].nameZh).toBe(name);
});

it("keeps the public salt name while using a literal hydrochloride alias only for retrieval", async () => {
  const query = product("SYNTHETIC HYDROCHLORIDE 1% Eye Ointment");
  const result = await readReferenceContent(search, [query], {
    fetcher: original("SYNTHETIC HYDROCHLORIDE ophthalmic"),
  });
  expect(result.state).toBe("found");
  expect(relevantReferenceText("SYNTHETIC HCl ophthalmic", [query])).toBe(true);
  expect(relevantReferenceText("SYNTHETIC ophthalmic", [query])).toBe(true);
  expect(query.nameZh).toBe("SYNTHETIC HYDROCHLORIDE 1% Eye Ointment");
  expect(query.ingredients).toEqual([]);
});

it.each([
  ["CompletelyDifferent ophthalmic", "眼藥膏"],
  ["SYNTHETIC HYDROCHLORIDE oral tablet", "眼藥膏"],
  ["SYNTHETIC HYDROCHLORIDE topical cream", "眼藥膏"],
])("still rejects a wrong name or route after suffix normalization: %s", async (heading, form) => {
  const result = await readReferenceContent(search, [product("SYNTHETIC HYDROCHLORIDE Eye Ointment", form)], {
    fetcher: original(heading),
  });
  expect(result.state).toBe("not_found");
  expect(result.passages).toEqual([]);
});

it.each([
  "SYNTHETIC + ANOTHER Eye Ointment",
  "SYNTHETIC Extended Release Eye Ointment",
  "SYNTHETIC Eye Ointment Plus",
  "SYNTHETIC 12 Eye Ointment",
])("does not discard other product qualifiers or combination ingredients: %s", (name) => {
  expect(relevantReferenceText("SYNTHETIC ophthalmic", [product(name)])).toBe(false);
});

it("does not strip a conflicting supplied form or invent a name from dosage alone", () => {
  expect(relevantReferenceText("SYNTHETIC ophthalmic", [product("SYNTHETIC Oral Tablets")])).toBe(false);
  expect(relevantReferenceText("SYNTHETIC ophthalmic", [product("SYNTHETIC Eye Ointment", "")])).toBe(true);
  expect(relevantReferenceText("SYNTHETIC ophthalmic", [product("1% Eye Ointment")])).toBe(false);
});

it.each([
  ["Synthetic 1% Eye Ointment", "Synthetic ophthalmic", "Synthetic oral tablet"],
  ["合成藥 1% 眼藥膏", "合成藥眼用軟膏", "合成藥口服錠"],
  ["Clotrimazole 1% cream", "Clotrimazole topical cream", "Clotrimazole vaginal cream"],
])("uses a literal name suffix when the separate form was omitted: %s", async (name, accepted, rejected) => {
  const query = product(name, "");
  expect((await readReferenceContent(search, [query], { fetcher: original(accepted) })).state).toBe("found");
  expect((await readReferenceContent(search, [query], { fetcher: original(rejected) })).state).toBe("not_found");
  expect(query.form).toBe("");
});

it.each([
  "Synthetic oral tablets Eye Ointment",
  "Synthetic Eye Ointment or Oral Tablets",
  "Synthetic Eye Ointment Plus",
])("does not infer a route or strip an ambiguous name: %s", (name) => {
  expect(relevantReferenceText("Synthetic ophthalmic", [product(name, "")])).toBe(false);
});

it.each([
  ["鹽酸四環素眼藥膏", "四環素眼藥膏"],
  ["Tetracycline Hydrochloride Eye Ointment", "Tetracycline ophthalmic"],
  ["Tetracycline HCl Eye Ointment", "Tetracycline ophthalmic"],
])("retrieves explicit hydrochloride/base-name originals without modifying identity: %s", async (name, heading) => {
  const query = product(name, "");
  expect((await readReferenceContent(search, [query], { fetcher: original(heading) })).state).toBe("found");
  expect((await readReferenceContent(search, [query], { fetcher: original(heading.replace(/眼藥膏|ophthalmic/, "oral tablet")) })).state).toBe("not_found");
  expect(query.nameZh).toBe(name);
  expect(query.ingredients).toEqual([]);
});

it.each([
  ["Tetracycline Hydrochloride Eye Ointment", "Oxytetracycline ophthalmic"],
  ["鹽酸四環素眼藥膏", "去甲四環素眼藥膏"],
  ["品牌鹽酸四環素眼藥膏", "四環素眼藥膏"],
  ["Brand Tetracycline Hydrochloride Eye Ointment", "Tetracycline ophthalmic"],
  ["Tetracycline Hydrochloride + Another Eye Ointment", "Tetracycline ophthalmic"],
  ["Tetracycline Sulfate Eye Ointment", "Tetracycline ophthalmic"],
  ["AB HCl Eye Ointment", "AB ophthalmic"],
])("does not turn salt relevance into fuzzy product/compound matching: %s", (name, heading) => {
  expect(relevantReferenceText(heading, [product(name, "")])).toBe(false);
});

it.each([
  ["合成藥 1% 乳膏", "乳膏", "合成藥外用乳膏"],
  ["Synthetic 100 mg Tablets", "錠劑", "Synthetic oral tablet"],
  ["Synthetic 10 mg/ml Oral Suspension", "口服懸液", "Synthetic oral suspension"],
  ["Synthetic 0.5% Ear Drops", "滴耳液", "Synthetic otic drops"],
])("handles literal form suffixes beyond eye ointments: %s", async (name, form, heading) => {
  expect((await readReferenceContent(search, [product(name, form)], {
    fetcher: original(heading),
  })).state).toBe("found");
});
