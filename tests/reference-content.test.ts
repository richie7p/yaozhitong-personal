import { expect, it, vi } from "vitest";
import {
  readReferenceContent,
  referenceHtmlText,
} from "../server/reference-content";
import type { Drug } from "../shared/schema";
import type { ReferenceSearch } from "../shared/assistance";

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
it.each([
  "http_error",
  "unsupported_pdf",
  "oversize",
  "wrong_ingredient",
  "timeout",
])(
  "never falls back to a generated summary when original retrieval fails: %s",
  async (kind) => {
    const fetcher = vi.fn().mockImplementation(async () => {
      if (kind === "timeout") throw Error("timeout");
      if (kind === "http_error") return new Response("error", { status: 403 });
      if (kind === "unsupported_pdf")
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
