import { expect, it, vi } from "vitest";
import {
  readReferenceContent,
  referenceHtmlText,
} from "../server/reference-content";
import type { Drug } from "../shared/schema";
import type { ReferenceSearch } from "../shared/assistance";
import { readReferencePdf, REFERENCE_PDF_BYTE_LIMIT } from "../server/reference-pdf";
import { buildTfdaRawPdf, PDF_FIXTURE_NAME_EN } from "./fixtures/tfda-raw-pdf-fixtures";

const drug = {
  nameZh: "合成藥品",
  nameEn: "Synthetic drug",
  ingredients: ["SYNTHETIC"],
} as Drug;
const source = {
  id: "web-1",
  title: "合成官方來源",
  url: "https://medlineplus.gov/synthetic",
  kind: "official" as const,
};
const search: ReferenceSearch = {
  state: "found",
  sources: [source],
  passages: [
    {
      text: "SYNTHETIC：搜尋摘要加入未受原文支持的長期影響。",
      sourceIds: [source.id],
    },
  ],
};
const literal =
  "SYNTHETIC has specific precautions. This source does not establish that it causes a long-term effect. Read the entire warning before interpreting the symptoms.";
const html = () =>
  new Response(`<main><h1>SYNTHETIC</h1><p>${literal}</p></main>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

it("replaces every generated search summary with the fetched original text", async () => {
  const fetcher = vi.fn().mockResolvedValue(html());
  const result = await readReferenceContent(search, [drug], { fetcher });
  expect(result.state).toBe("found");
  expect(result.passages[0].text).toContain(literal);
  expect(JSON.stringify(result)).not.toContain("搜尋摘要");
  expect(result.sources[0].url).toBe(source.url);
  const request = fetcher.mock.calls[0][1];
  expect(request.redirect).toBe("manual");
  expect(request.headers).not.toHaveProperty("authorization");
});
it("keeps headings and lists while removing scripts, navigation and hidden content", () => {
  const text = referenceHtmlText(
    "<nav>discard</nav><main><h2>Warning</h2><p>If symptoms:</p><ul><li>item &amp; condition</li></ul><script>discard</script><span hidden>discard</span></main>",
  );
  expect(text).toContain("Warning\n");
  expect(text).toContain("If symptoms:");
  expect(text).toContain("item & condition");
  expect(text).not.toContain("discard");
  expect(
    referenceHtmlText(
      "<main><table><tr><td>5</td><td>10</td></tr></table></main>",
    ),
  ).toBe("5\n\n10");
});
it("reads hospital originals for an unconfirmed eye ointment and rejects an oral source", async () => {
  const eyeQuery = {
    ...drug, nameZh: "合成鹽酸四環素", nameEn: "", ingredients: [],
    form: "眼藥膏", identityVerified: false,
  };
  const hospitalSearch: ReferenceSearch = {
    state: "found",
    sources: [{ id: "eye", title: "合成眼用資料", kind: "hospital", url: "https://www.cth.org.tw/synthetic-eye" }],
    passages: [],
  };
  const original = "這是測試用的合成來源文字，僅用來核對完整原文是否被保留，並非真實醫療建議。".repeat(5);
  const fetcher = vi.fn().mockResolvedValue(new Response(`<main><h1>合成鹽酸四環素眼藥膏</h1><p>${original}</p></main>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
  const result = await readReferenceContent(hospitalSearch, [eyeQuery], { fetcher });
  expect(result.state).toBe("found");
  expect(result.passages[0].text).toContain(original);
  expect(result.sources[0].kind).toBe("hospital");
  const oralFetcher = vi.fn().mockResolvedValue(new Response(`<main><h1>合成鹽酸四環素口服膠囊</h1><p>${original}</p></main>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
  expect(await readReferenceContent(hospitalSearch, [eyeQuery], { fetcher: oralFetcher })).toEqual({
    state: "not_found", sources: [], passages: [],
  });
});
it.each([
  "http_error",
  "invalid_pdf",
  "oversize",
  "wrong_ingredient",
  "timeout",
])(
  "never falls back to a generated summary when original retrieval fails: %s",
  async (kind) => {
    const fetcher = vi.fn().mockImplementation(async () => {
      if (kind === "timeout") throw Error("timeout");
      if (kind === "http_error") return new Response("error", { status: 403 });
      if (kind === "invalid_pdf")
        return new Response("%PDF", {
          headers: { "content-type": "application/pdf" },
        });
      if (kind === "oversize")
        return new Response("SYNTHETIC ".repeat(100001), {
          headers: { "content-type": "text/plain" },
        });
      return new Response("UNRELATED ".repeat(25), {
        headers: { "content-type": "text/plain" },
      });
    });
    expect(await readReferenceContent(search, [drug], { fetcher })).toEqual({
      state: kind === "wrong_ingredient" ? "not_found" : "unavailable",
      sources: [],
      passages: [],
    });
  },
);

it("reads complete original prose from a real PDF and retains the trusted citation", async () => {
  const pdf = buildTfdaRawPdf();
  const fetcher = vi.fn(async () => new Response(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-length": String(pdf.length) },
  }));
  const result = await readReferenceContent(search,
    [{ ...drug, nameEn: PDF_FIXTURE_NAME_EN, form: "錠" }], { fetcher });
  expect(result.state).toBe("found");
  expect(result.sources[0].url).toBe(source.url);
  expect(result.passages[0].text).toContain(PDF_FIXTURE_NAME_EN);
  expect(result.passages[0].text).toContain("Preserve the complete second physical page and its original order.");
  expect(result.passages[0].text).toContain("only when synthetic condition A holds.");
  expect(JSON.stringify(result)).not.toContain("搜尋摘要");
});

it.each([
  ["scanned or missing page text", { blankSecondPage: true }],
  ["ambiguous table", { tableGrid: true }],
  ["ambiguous columns", { twoColumns: true }],
  ["dominant image", { largeImage: true }],
] as const)("does not use partial prose from a PDF with %s", async (_reason, options) => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array(buildTfdaRawPdf(options)), {
    headers: { "content-type": "application/pdf" },
  }));
  const result = await readReferenceContent(search, [drug], { fetcher });
  expect(result).toEqual({ state: "unavailable", sources: [], passages: [] });
});

it("applies the same exact name/form relevance rules after PDF text extraction", async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array(buildTfdaRawPdf()), {
    headers: { "content-type": "application/pdf" },
  }));
  const wrongName = await readReferenceContent(search,
    [{ ...drug, nameZh: "完全不同藥名", nameEn: "UnrelatedMedicine", ingredients: [] }], { fetcher });
  expect(wrongName.state).toBe("not_found");
  const wrongForm = await readReferenceContent(search,
    [{ ...drug, nameEn: PDF_FIXTURE_NAME_EN, form: "乳膏" }], { fetcher });
  expect(wrongForm.state).toBe("not_found");
});

it("rejects oversized or already-aborted PDFs without starting an unbounded parser", async () => {
  const oversized = Buffer.alloc(REFERENCE_PDF_BYTE_LIMIT + 1);
  oversized.write("%PDF-");
  await expect(readReferencePdf(oversized, AbortSignal.timeout(1000))).rejects.toThrow("invalid_reference_pdf");
  const controller = new AbortController(); controller.abort();
  await expect(readReferencePdf(buildTfdaRawPdf(), controller.signal)).rejects.toThrow();
});

it.each([
  ["more than twenty pages", { pageCount: 21 }],
  ["more than the complete-document text budget", { longText: true }],
] as const)("rejects a whole PDF with %s instead of clipping it", async (_reason, options) => {
  await expect(readReferencePdf(buildTfdaRawPdf(options), AbortSignal.timeout(5000)))
    .rejects.toThrow("unreadable_reference_pdf");
});

it("terminates an interrupted parser and leaves the next PDF query usable", async () => {
  const controller = new AbortController();
  const interrupted = readReferencePdf(buildTfdaRawPdf(), controller.signal);
  const timer = setTimeout(() => controller.abort(), 10);
  await expect(interrupted).rejects.toThrow("reference_pdf_aborted");
  clearTimeout(timer);
  const text = await readReferencePdf(buildTfdaRawPdf(), AbortSignal.timeout(5000));
  expect(text).toContain("Preserve the complete second physical page");
});
it.each([
  "https://attacker.test/",
  "http://medlineplus.gov/",
  "https://127.0.0.1/",
])("does not follow an untrusted redirect: %s", async (url) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: url } }),
    );
  const result = await readReferenceContent(search, [drug], { fetcher });
  expect(result.state).toBe("unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("follows a bounded trusted redirect and cites the actual destination", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "/actual-synthetic" },
      }),
    )
    .mockResolvedValueOnce(html());
  const result = await readReferenceContent(search, [drug], { fetcher });
  expect(result.sources[0].url).toBe(
    "https://medlineplus.gov/actual-synthetic",
  );
});
it("keeps no-source outcomes without making speculative requests", async () => {
  const fetcher = vi.fn();
  expect(
    (
      await readReferenceContent({ ...search, state: "not_found" }, [drug], {
        fetcher,
      })
    ).state,
  ).toBe("not_found");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["Clotrimazole Vaginal", "Clotrimazole Oral Troches"])(
  "does not use a different formulation's original for a skin cream: %s",
  async (heading) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `<main><h1>${heading}</h1><p>${"CLOTRIMAZOLE synthetic route-specific source. ".repeat(5)}</p></main>`,
          { headers: { "content-type": "text/html" } },
        ),
      );
    const result = await readReferenceContent(
      search,
      [{ ...drug, ingredients: ["CLOTRIMAZOLE"], form: "乳膏" }],
      { fetcher },
    );
    expect(result.state).toBe("not_found");
    expect(result.passages).toEqual([]);
  },
);
it("retains a topical original even when its body warns against oral or vaginal use", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        `<main><h1>Clotrimazole Topical</h1><p>${"CLOTRIMAZOLE synthetic source. ".repeat(5)}Do not use orally or vaginally.</p></main>`,
        { headers: { "content-type": "text/html" } },
      ),
    );
  const result = await readReferenceContent(
    search,
    [{ ...drug, ingredients: ["CLOTRIMAZOLE"], form: "乳膏" }],
    { fetcher },
  );
  expect(result.state).toBe("found");
  expect(result.passages[0].text).toContain("Do not use orally or vaginally");
});
it.each([
  ["SYNTHETIC Oral Antibiotic", "膠囊"],
  ["SYNTHETIC Topical Antibiotic", "乳膏"],
])(
  "does not confuse antibiotic in a source heading with ear use: %s",
  async (heading, form) => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`<main><h1>${heading}</h1><p>${literal}</p></main>`, {
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await readReferenceContent(search, [{ ...drug, form }], {
      fetcher,
    });
    expect(result.state).toBe("found");
    expect(result.passages[0].text).toContain(literal);
  },
);
