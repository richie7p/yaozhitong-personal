import type { Drug } from "../shared/schema.js";
import type { Store } from "./store.js";
import { Blobs } from "./blobs.js";
import {
  ProductIdentityIndex,
  type IdentityInput,
} from "../shared/product-identity.js";
export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s「」"“”]/g, "");

// Candidate identity uses a small set of dosage-form aliases, never ingredient
// strengths. A generic liquid label only matches a syrup when both official and
// transcribed product titles explicitly say syrup; oral solutions stay distinct.
function formMatches(d: Drug, form: string, query: string) {
  if (!form) return true;
  const supplied = normalize(form),
    actual = normalize(d.form);
  // A bare liquid label does not establish an injectable, topical or eye route.
  if (
    supplied === "液劑" &&
    actual !== "液劑" &&
    !/^(?:糖漿劑?|內服液劑?|口服液劑?)$/u.test(actual)
  )
    return false;
  if (actual.includes(supplied)) return true;
  if (/^(?:capsules?|膠囊劑?)$/u.test(supplied)) return actual.includes("膠囊");
  if (/^(?:tablets?|tabs?|錠劑?)$/u.test(supplied))
    return actual.includes("錠");
  const saysSyrup = (title: string) =>
    /(?:^|[^a-z])syrup(?:$|[^a-z])/i.test(title.normalize("NFKC")) ||
    /糖漿/u.test(title);
  if (
    saysSyrup(d.nameZh + " " + d.nameEn) &&
    /^(?:糖漿劑?|內服液劑?|口服液劑?)$/u.test(actual)
  ) {
    if (/^(?:syrup|糖漿劑?)$/u.test(supplied)) return true;
    if (/^(?:液劑|內服液劑?|口服液劑?)$/u.test(supplied) && saysSyrup(query))
      return true;
  }
  return false;
}

// These explicitly enumerated ingredient-name variants support candidate
// checking only. Salt names are not converted to equal masses or dose units.
const ingredientNames: Record<string, string> = {
  thiamine: "thiamine",
  thiaminemononitrate: "thiamine",
  pyridoxine: "pyridoxine",
  pyridoxinehcl: "pyridoxine",
  pyridoxinehydrochloride: "pyridoxine",
  cyanocobalamin: "cyanocobalamin",
  "cyanocobalamin(vitb12)": "cyanocobalamin",
};
function fullBrandAndIngredientsMatch(
  d: Drug,
  query: string,
  strength: string,
  form: string,
) {
  // This additional path does not infer, discard or reconcile a stated strength.
  if (strength || d.strength || !formMatches(d, form, query)) return false;
  const match = query
    .normalize("NFKC")
    .trim()
    .match(/^([A-Za-z][A-Za-z0-9 .'-]*?)\s*\(([^()]+)\)$/u);
  if (!match || titleQuantities(query).quantities.length) return false;
  const brand = normalize(match[1]);
  const official = normalize(d.nameEn);
  if (!official.startsWith(brand)) return false;
  // Require the entire English brand followed only by its complete dosage form.
  // A short prefix, extra brand modifier, official ingredient or amount fails.
  if (!/^(?:capsules?|tablets?|syrup)$/u.test(official.slice(brand.length)))
    return false;
  const actual = d.ingredients.map((s) => ingredientNames[normalize(s)]);
  const supplied = match[2]
    .split(/\s*&\s*/u)
    .map((s) => ingredientNames[normalize(s)]);
  if (
    actual.length < 2 ||
    actual.some((s) => !s) ||
    supplied.some((s) => !s) ||
    new Set(actual).size !== actual.length ||
    new Set(supplied).size !== supplied.length ||
    actual.length !== supplied.length
  )
    return false;
  return supplied.every((s) => actual.includes(s));
}
// Deliberately limited identity support: unit aliases, never dose conversion.
const singleMilligrams = (text: string) => {
  const match = normalize(text).match(/^(\d+(?:\.\d+)?)(?:mg|毫克)$/);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
};
function titleQuantities(text: string) {
  const title = text.normalize("NFKC").toLowerCase();
  const quantities = [
    ...title.matchAll(
      /(?<![\dA-Za-z.])(\d+(?:\.\d+)?)\s*(毫克|微克|公克|國際單位|毫升|mcg|mg|gm|ml|iu|g|μg|克|單位|%)(?![A-Za-z])/gu,
    ),
  ];
  return { title, quantities };
}
function withoutSingleStrength(text: string, milligrams: number) {
  const { title, quantities } = titleQuantities(text);
  if (/[/%]/.test(title) || quantities.length > 1) return null;
  if (!quantities.length) return normalize(title);
  const quantity = quantities[0];
  if (singleMilligrams(quantity[0]) !== milligrams) return null;
  return normalize(
    title.slice(0, quantity.index) +
      title.slice(quantity.index! + quantity[0].length),
  );
}
function strengthIdentity(
  d: Drug,
  query: string,
  strength: string,
  form: string,
) {
  const supplied = singleMilligrams(strength);
  if (supplied === null)
    return { conflict: false, equivalent: false, splitNameMatch: false };
  const metadata = singleMilligrams(d.strength);
  const titles = [d.nameZh, d.nameEn].map(titleQuantities);
  const known = [
    metadata,
    ...titles
      .filter((t) => t.quantities.length === 1)
      .map((t) => singleMilligrams(t.quantities[0][0])),
  ].filter((value): value is number => value !== null);
  const queryQuantities = titleQuantities(query).quantities;
  const queryStrength =
    queryQuantities.length === 1
      ? singleMilligrams(queryQuantities[0][0])
      : null;
  if (
    known.some((value) => value !== supplied) ||
    (queryStrength !== null && queryStrength !== supplied)
  )
    return { conflict: true, equivalent: false, splitNameMatch: false };
  const equivalent = known.length > 0;
  // Additional matching must not simplify a combination, concentration, unknown
  // strength notation, ingredient qualifier, dosage form, or numbered brand.
  if (
    !equivalent ||
    d.ingredients.length > 1 ||
    (d.strength.trim() && metadata === null) ||
    titles.some((t) => t.quantities.length > 1 || /[/%]/.test(t.title)) ||
    !formMatches(d, form, query)
  )
    return { conflict: false, equivalent, splitNameMatch: false };
  const strippedQuery = withoutSingleStrength(query, supplied);
  const splitNameMatch =
    !!strippedQuery &&
    [d.nameZh, d.nameEn].some((title) => {
      const strippedTitle = withoutSingleStrength(title, supplied);
      return strippedTitle !== null && strippedTitle === strippedQuery;
    });
  return { conflict: false, equivalent, splitNameMatch };
}

function bilingualNameMatch(
  d: Drug,
  query: string,
  strength: string,
  form: string,
) {
  if (
    !d.nameZh ||
    !d.nameEn ||
    d.ingredients.length > 1 ||
    !formMatches(d, form, query) ||
    [d.nameZh, d.nameEn, d.strength].some((text) => /[/%]/.test(text))
  )
    return false;
  // A per-tablet strength may still identify a candidate for manual checking,
  // but it is never made equivalent to plain mg or stripped from the query.
  const perTablet = strength
    .normalize("NFKC")
    .match(/^(\d+(?:\.\d+)?)\s*mg\s*\/\s*(?:tab|tablet|tablets|錠)$/i);
  if (/[/%]/.test(strength) && !perTablet) return false;
  const knownMilligrams = [
    singleMilligrams(d.strength),
    ...[d.nameZh, d.nameEn].flatMap((text) =>
      titleQuantities(text).quantities.map((quantity) =>
        singleMilligrams(quantity[0]),
      ),
    ),
  ].filter((value): value is number => value !== null);
  const queryMilligrams = [
    ...(perTablet ? [Number(perTablet[1])] : []),
    ...titleQuantities(query).quantities.map((quantity) =>
      singleMilligrams(quantity[0]),
    ),
  ].filter((value): value is number => value !== null);
  if (
    queryMilligrams.some((value) =>
      knownMilligrams.some((known) => known !== value),
    )
  )
    return false;

  const matchesPart = (title: string, part: string, english: boolean) => {
    const candidate = normalize(title),
      prefix = normalize(part);
    if (!candidate.startsWith(prefix)) return false;
    const remainder = candidate.slice(prefix.length);
    if (!remainder) return true;
    // Only a complete brand prefix followed by a known dosage form and optional
    // single strength is supported. Never discard ingredient/brand qualifiers.
    const dosageForm = english
      ? "(?:film-coatedtablets?|tablets?|capsules?|syrup|cream|drops?|solution)"
      : "(?:腸溶膜衣錠|膜衣錠|腸溶錠|緩釋錠|錠劑?|膠囊劑?|糖漿劑?|乳膏劑?|滴劑|口服液劑?)";
    return new RegExp(`^${dosageForm}(?:\\d+(?:\\.\\d+)?(?:mg|毫克))?$`).test(
      remainder,
    );
  };
  const text = query
    .normalize("NFKC")
    .replace(/[「」"“”]/g, "")
    .trim();
  const boundaries = [
    ...text.matchAll(
      /\s+|(?<=[A-Za-z0-9])(?=\p{Script=Han})|(?<=\p{Script=Han})(?=[A-Za-z])/gu,
    ),
  ];
  return boundaries.some((boundary) => {
    const parts = [
      text.slice(0, boundary.index).trim(),
      text.slice(boundary.index! + boundary[0].length).trim(),
    ];
    for (const [english, chinese] of [parts, [...parts].reverse()]) {
      if (
        !/^[A-Za-z][A-Za-z0-9\s.,'()/-]*$/.test(english) ||
        (english.match(/[A-Za-z]/g)?.length || 0) < 3 ||
        (chinese.match(/\p{Script=Han}/gu)?.length || 0) < 2
      )
        continue;
      if (
        matchesPart(d.nameEn, english, true) &&
        matchesPart(d.nameZh, chinese, false)
      )
        return true;
    }
    return false;
  });
}

export function scoreDrug(d: Drug, q: string, strength = "", form = "") {
  // An incompatible supplied form must not survive merely because an exact
  // name's positive score outweighed the former form-mismatch penalty.
  if (!formMatches(d, form, q)) return 0;
  if (
    strength &&
    !d.strength &&
    [d.nameZh, d.nameEn].every(
      (title) => !titleQuantities(title).quantities.length,
    )
  )
    return 0;
  const identity = strengthIdentity(d, q, strength, form);
  if (identity.conflict) return 0;
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
  if (identity.splitNameMatch) s = Math.max(s, 85);
  if (s === 0 && bilingualNameMatch(d, q, strength, form)) s = 85;
  if (s === 0 && fullBrandAndIngredientsMatch(d, q, strength, form)) s = 85;
  if (d.licenseNo === q) s = 150;
  if (s === 0) return 0;
  if (strength)
    s +=
      normalize(d.strength) === normalize(strength) || identity.equivalent
        ? 50
        : -80;
  if (form) s += 30;
  if (d.revoked) s -= 20;
  return s;
}
export class Catalog {
  private version = "";
  private rows: Drug[] = [];
  private loadedAt = 0;
  private identityRows: Drug[] | null = null;
  private identityIndex: ProductIdentityIndex | null = null;
  constructor(
    private store: Store,
    private blobs = new Blobs(),
  ) {}
  async all(refresh = false) {
    if (!refresh && Date.now() - this.loadedAt < 30000) return this.rows;
    const m = await this.store.get("settings", "catalog");
    if (m && m.version !== this.version) {
      this.rows = JSON.parse((await this.blobs.get(m.path)).toString());
      this.version = m.version;
    }
    if (!m && this.version) {
      this.rows = [];
      this.version = "";
    }
    this.loadedAt = Date.now();
    return this.rows;
  }
  async search(q: string, strength = "", form = "") {
    if (q.trim().length < 2) return [];
    return (await this.all())
      .map((d) => ({ ...d, score: scoreDrug(d, q, strength, form) }))
      .filter((d) => d.score > 0)
      .sort(
        (a, b) => Number(a.revoked) - Number(b.revoked) || b.score - a.score,
      )
      .slice(0, 12);
  }
  async get(lic: string) {
    return (await this.all()).find((d) => d.licenseNo === lic) || null;
  }
  async identitySnapshot() {
    // Product proof must be checked against the current catalog version even
    // during the search cache's 30-second lifetime. Only a version change loads
    // the catalog blob and rebuilds the exact-name/complete-license indexes.
    const rows = await this.all(true);
    if (this.identityRows !== rows || !this.identityIndex) {
      this.identityRows = rows;
      this.identityIndex = new ProductIdentityIndex(rows);
    }
    return this.identityIndex;
  }
  async identityReview(input: IdentityInput) {
    return (await this.identitySnapshot()).review(input);
  }
  invalidate() {
    this.loadedAt = 0;
  }
}
