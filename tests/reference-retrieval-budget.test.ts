import { expect, it, vi } from "vitest";
import { canonicalReferenceUrl, referenceSearchCandidates } from "../server/reference-search";
import { readReferenceContent } from "../server/reference-content";
import type { Drug } from "../shared/schema";
import type { ReferenceSearch } from "../shared/assistance";

const drug: Drug = {
  licenseNo: "", nameZh: "合成測試藥", nameEn: "SyntheticMedicine",
  strength: "", form: "眼藥膏", ingredients: [], revoked: false,
};
const provider = (sources: unknown[], citations: unknown[] = []) => ({
  status: "completed",
  output: [
    { type: "web_search_call", status: "completed", action: { sources } },
    { type: "message", content: [{ type: "output_text", text: "Generated search summary is not evidence.",
      annotations: citations.map((citation: any) => ({ type: "url_citation", ...citation })) }] },
  ],
});
const sources = (count: number): ReferenceSearch => ({
  state: "found",
  sources: Array.from({ length: count }, (_, i) => ({
    id: "web-" + (i + 1), title: "Metadata is only a hint", kind: "hospital",
    url: "https://www.cth.org.tw/synthetic/" + i,
  })),
  passages: [{ text: "Generated search summary must never become evidence.", sourceIds: ["web-1"] }],
});
const page = (name = drug.nameEn, form = "ophthalmic") => new Response(
  `<main><h1>${name} ${form}</h1><p>${"This is a synthetic fixture, not clinical information. Preserve this complete original condition. ".repeat(3)}</p></main>`,
  { headers: { "content-type": "text/html" } },
);

it("removes only UTM parameters without re-encoding document identifiers or other URL components", () => {
  expect(canonicalReferenceUrl("https://www.cth.org.tw/?aid=606&UTM_source=chat%20gpt&iid=810&name=one%20two&tag=~&tag=%2F&utm_campaign=x#section"))
    .toBe("https://www.cth.org.tw/?aid=606&iid=810&name=one%20two&tag=~&tag=%2F#section");
  expect(canonicalReferenceUrl("https://www.cth.org.tw/x?utm=keep&x_utm_source=keep&%75tm_medium=remove&bad%ZZ=keep&value=utm_source#part"))
    .toBe("https://www.cth.org.tw/x?utm=keep&x_utm_source=keep&bad%ZZ=keep&value=utm_source#part");
  expect(canonicalReferenceUrl("https://www.cth.org.tw/x?utm_source=a&utm_source=b#part"))
    .toBe("https://www.cth.org.tw/x#part");
  expect(canonicalReferenceUrl("https://www.cth.org.tw/x?name=one%20two&name=~"))
    .toBe("https://www.cth.org.tw/x?name=one%20two&name=~");
  expect(canonicalReferenceUrl("https://cth.org.tw.attacker.test/x?utm_source=a")).toBeUndefined();
  expect(canonicalReferenceUrl("http://cth.org.tw/x?utm_source=a")).toBeUndefined();
});

it("deduplicates tracking variants before the cap while retaining distinct product query parameters", () => {
  const base = "https://www.cth.org.tw/?page_name=detail&pid=40";
  const result = referenceSearchCandidates(provider([
    ...Array.from({ length: 20 }, (_, i) => ({ url: base + "&utm_source=" + i })),
    { url: "https://www.cth.org.tw/?page_name=detail&pid=41" },
  ]), [drug]);
  expect(result.sources.map((s) => s.url)).toEqual([base, "https://www.cth.org.tw/?page_name=detail&pid=41"]);
  expect(result.sources.map((s) => s.id)).toEqual(["web-1", "web-2"]);
  expect(result.passages).toEqual([]);
});

it("retains a useful late hospital candidate instead of filling all twelve slots with one host", () => {
  const inventories = Array.from({ length: 20 }, (_, i) => ({
    url: "https://www.fda.gov.tw/inventory/" + i, title: "Product inventory",
  }));
  const hospital = { url: "https://www.cth.org.tw/synthetic-eye", title: "SyntheticMedicine ophthalmic guidance" };
  const result = referenceSearchCandidates(provider([hospital], inventories), [drug]);
  expect(result.sources).toHaveLength(12);
  expect(result.sources[0]).toMatchObject({ id: "web-1", url: hospital.url, kind: "hospital" });
  expect(result.passages).toEqual([]);
});

it("spreads early reads across trusted host groups, including their subdomains", () => {
  const result = referenceSearchCandidates(provider([
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://ward${i}.ntuh.gov.tw/source`, title: "SyntheticMedicine ophthalmic" })),
    ...["cth.org.tw", "mmh.org.tw", "cgmh.org.tw", "vghtpe.gov.tw", "medlineplus.gov"].map((host) => ({
      url: `https://${host}/source`, title: "SyntheticMedicine ophthalmic",
    })),
  ]), [drug]);
  expect(result.sources).toHaveLength(12);
  expect(result.sources.slice(0, 6).filter((s) => new URL(s.url).hostname.endsWith("ntuh.gov.tw"))).toHaveLength(1);
  expect(result.sources.slice(0, 6).some((s) => s.url.startsWith("https://medlineplus.gov/"))).toBe(true);
});

it.each([
  ["眼藥膏", "ophthalmic"], ["滴耳液", "otic"], ["乳膏", "topical"], ["錠劑", "oral"],
])("prefers an explicit %s match but retains unknown/conflicting titles for original-text checks", (form, route) => {
  const entries = ["general", "ophthalmic", "otic", "topical", "oral"].map((name) => ({
    url: `https://www.cth.org.tw/${name}`, title: "SyntheticMedicine " + name,
  }));
  const result = referenceSearchCandidates(provider(entries), [{ ...drug, form }]);
  expect(result.sources[0].url).toBe(`https://www.cth.org.tw/${route}`);
  expect(result.sources).toHaveLength(entries.length);
  expect(result.sources[1].url).toBe("https://www.cth.org.tw/general");
});

it("merges an explicit form title from later metadata without duplicating the cited URL", () => {
  const url = "https://www.cth.org.tw/synthetic";
  const result = referenceSearchCandidates(provider([
    { url, title: "SyntheticMedicine ophthalmic guidance" },
    { url: "https://www.cth.org.tw/uncited", title: "SyntheticMedicine ophthalmic guidance" },
  ], [{ url: url + "?utm_source=chat", title: "Medicine information" }]), [drug]);
  expect(result.sources).toHaveLength(2);
  expect(result.sources[0]).toMatchObject({ url, title: "SyntheticMedicine ophthalmic guidance" });
});

it.each(["cmuh.org.tw", "tmuh.org.tw"])("attributes verified %s domains and subdomains as hospital sources", (host) => {
  const result = referenceSearchCandidates(provider([
    { url: `https://${host}/medicine` }, { url: `https://drug.${host}/medicine` },
    { url: `https://${host}.attacker.test/medicine` },
  ]), [drug]);
  expect(result.sources).toHaveLength(2);
  expect(result.sources.every((source) => source.kind === "hospital")).toBe(true);
});

it.each(["wrong_name", "wrong_form", "unreadable"])(
  "reaches later candidates when the first six originals are %s", async (failure) => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (url: string) => {
      const index = Number(new URL(url).pathname.split("/").at(-1));
      if (index >= 6) return page();
      if (failure === "unreadable") return new Response("No original available", { status: 403 });
      return failure === "wrong_name" ? page("UnrelatedMedicine") : page(drug.nameEn, "oral");
    });
    const result = await readReferenceContent(sources(12), [drug], { fetcher: fetcher as typeof fetch, signal: controller.signal });
    expect(result.state).toBe("found");
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(12);
    expect(fetcher.mock.calls.every((call: any) => call[1].signal === controller.signal)).toBe(true);
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    expect(result.sources.map((s) => s.id)).toEqual(
      Array.from({ length: result.sources.length }, (_, i) => "web-" + (i + 7)),
    );
    expect(result.passages.every((p) => p.text.includes("complete original condition"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Generated search summary");
  },
);

it("does not let two name-matching inventories hide a later educational original", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = vi.fn(async (url: string) => {
    if (/\/[01]$/.test(url)) return page(drug.nameEn + " inventory");
    await blocked;
    return url.endsWith("/10") ? page() : page("UnrelatedMedicine");
  });
  const pending = readReferenceContent(sources(12), [drug], { fetcher: fetcher as typeof fetch });
  // Complete the two fast originals while all other requests remain pending.
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const result = await pending;
  expect(result.state).toBe("found");
  expect(result.sources.map((s) => s.id)).toEqual(["web-1", "web-2", "web-11"]);
  expect(fetcher).toHaveBeenCalledTimes(12);
});

it("does not let one combination-product original prevent a later standalone original", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/0")) return page(drug.nameEn + " + AnotherIngredient");
    return url.endsWith("/8") ? page() : page("UnrelatedMedicine");
  });
  const result = await readReferenceContent(sources(12), [drug], { fetcher: fetcher as typeof fetch });
  expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(9);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(12);
  expect(result.sources.map((s) => s.id)).toEqual(["web-1", "web-9"]);
  expect(result.passages[0].text).toContain("AnotherIngredient");
  expect(result.passages[1].text).not.toContain("AnotherIngredient");
});

it("counts redirects to the same original as one source when considering later candidates", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/1")) return new Response(null, { status: 302, headers: { location: "/synthetic/0" } });
    return /\/[06]$/.test(url) ? page() : page("UnrelatedMedicine");
  });
  const result = await readReferenceContent(sources(12), [drug], { fetcher: fetcher as typeof fetch });
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(13); // At most twelve candidates plus one trusted redirect.
  expect(result.sources.map((s) => s.id)).toEqual(["web-1", "web-7"]);
});

it("does not create a fresh deadline or start later candidates after the shared signal aborts", async () => {
  const controller = new AbortController();
  let requested = 0;
  const fetcher = vi.fn(async () => {
    if (++requested === 6) controller.abort();
    return page("UnrelatedMedicine");
  });
  const result = await readReferenceContent(sources(12), [drug], { fetcher, signal: controller.signal });
  expect(result.passages).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(6);
  const abortedFetcher = vi.fn();
  await readReferenceContent(sources(12), [drug], { fetcher: abortedFetcher, signal: controller.signal });
  expect(abortedFetcher).not.toHaveBeenCalled();
});

it("reaches valid later originals while the first request is still pending, within six concurrent reads", async () => {
  const controller = new AbortController();
  let active = 0, peak = 0;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    active++; peak = Math.max(peak, active);
    try {
      const index = Number(new URL(url).pathname.split("/").at(-1));
      if (index === 0) {
        await new Promise<never>((_resolve, reject) => options!.signal!.addEventListener(
          "abort", () => reject(Error("shared deadline reached")), { once: true },
        ));
      }
      // Keep every initial request pending for one microtask, and allow the
      // later valid source to complete before the earlier valid source.
      if (index === 6) await new Promise<void>((resolve) => setImmediate(resolve));
      else await Promise.resolve();
      return index === 6 || index === 7 ? page() : page("UnrelatedMedicine");
    } finally { active--; }
  });
  const pending = readReferenceContent(sources(15), [drug], { fetcher: fetcher as typeof fetch, signal: controller.signal });
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/7"))).toBe(true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  expect(result.sources.map((s) => s.id)).toEqual(["web-7", "web-8"]);
  expect(result.passages.every((p) => p.text.includes("complete original condition"))).toBe(true);
  expect(peak).toBe(6);
  expect(active).toBe(0);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(12);
  expect(fetcher.mock.calls.every(([, options]) => options?.signal === controller.signal)).toBe(true);
});

it.each([false, true])("caps reading at twelve unique sources and keeps failure states accurate (unreadable=%s)", async (unreadable) => {
  const fetcher = vi.fn(async () => unreadable ? new Response("Unavailable", { status: 403 }) : page("UnrelatedMedicine"));
  const result = await readReferenceContent(sources(15), [drug], { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(12);
  expect(result).toEqual({ state: unreadable ? "unavailable" : "not_found", sources: [], passages: [] });
});

it("keeps late patient-information originals ahead of long inventories when context is bounded", async () => {
  const original = (drug.nameEn + " fixture only. 用途：合成測試。注意事項：保留完整條件。副作用：合成測試。保存方式：合成測試。 ").repeat(3);
  const inventory = (drug.nameEn + " inventory entry ").repeat(650);
  const fetcher = vi.fn(async (url: string) => new Response(url.endsWith("/3") ? original : inventory,
    { headers: { "content-type": "text/plain" } }));
  const result = await readReferenceContent(sources(4), [drug], { fetcher: fetcher as typeof fetch });
  expect(result.sources[0].id).toBe("web-4");
  expect(result.passages[0].text).toBe(original.trim());
  expect(result.passages.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(60000);
});

it("does not let duplicate tracking URLs consume the original-reading slots", async () => {
  const input = sources(2);
  input.sources = [
    ...Array.from({ length: 12 }, (_, i) => ({ ...input.sources[0], id: `duplicate-${i}`, url: input.sources[0].url + "?utm_source=" + i })),
    input.sources[1],
  ];
  const fetcher = vi.fn(async (url: string) => url.endsWith("/1") ? page() : page("UnrelatedMedicine"));
  const result = await readReferenceContent(input, [drug], { fetcher: fetcher as typeof fetch });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.sources.map((s) => s.id)).toEqual(["web-2"]);
});

it("still rejects an oral original even if provider metadata calls it an eye medicine", async () => {
  const input = referenceSearchCandidates(provider([{ url: "https://www.cth.org.tw/mislabelled", title: "SyntheticMedicine ophthalmic" }]), [drug]);
  const result = await readReferenceContent(input, [drug], { fetcher: vi.fn(async () => page(drug.nameEn, "oral")) });
  expect(result).toEqual({ state: "not_found", sources: [], passages: [] });
});

it.each(["Eye Ointment", "Eye Ointments"])("recognizes an explicit %s source without equating it with skin ointment", async (form) => {
  const input = sources(1);
  const fetcher = vi.fn(async () => page(drug.nameEn, form));
  expect((await readReferenceContent(input, [drug], { fetcher })).state).toBe("found");
  const skinQuery = { ...drug, form: "皮膚軟膏" };
  expect((await readReferenceContent(input, [skinQuery], { fetcher })).state).toBe("not_found");
});
