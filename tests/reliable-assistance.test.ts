import { expect, it, vi } from "vitest";
import {
  referenceSearchRequest,
  parseReferenceSearch,
} from "../server/reference-search";
import { assisted } from "../server/assistance";
import { reliableReferenceUrl } from "../shared/assistance";
import { Domain, hash } from "../server/domain";
import { MemoryStore } from "../server/store";
import type { Drug, Medication } from "../shared/schema";

const drug: Drug = {
  licenseNo: "TEST-REFERENCE",
  nameZh: "合成參考錠",
  nameEn: "Synthetic reference",
  strength: "10mg",
  form: "錠",
  ingredients: ["SYNTHETIC OXALATE"],
  revoked: false,
};
const med = {
  id: "med",
  ownerId: "owner",
  name: drug.nameZh,
  licenseNo: drug.licenseNo,
  doseAmount: 1,
  doseUnit: "錠",
  frequencyRaw: "QD",
  instructions: "合成用法",
  revision: 1,
  confirmed: true,
} as Medication;
const url = "https://www.ntuh.gov.tw/test-reference";
const source = {
  id: "web-1",
  title: "合成醫院資料",
  url,
  kind: "hospital" as const,
};
const search = {
  state: "found" as const,
  sources: [source],
  passages: [
    { text: "SYNTHETIC OXALATE 的合成一般資訊。", sourceIds: [source.id] },
  ],
};
const claim = {
  text: "關於 SYNTHETIC 成分的一般資訊。",
  basis: "reference" as const,
  sourceIds: [source.id],
  evidenceQuotes: [{ sourceId: source.id, quote: search.passages[0].text }],
};

it("restricts retrieval to canonical product fields, never the user's private question / profile / notes", () => {
  const request = referenceSearchRequest(
    [
      {
        ...drug,
        question: "PRIVATE",
        notes: "PRIVATE",
        ownerId: "PRIVATE",
      } as any,
    ],
    "test-model",
  );
  expect(JSON.stringify(request)).not.toContain("PRIVATE");
  expect(request.store).toBe(false);
  expect(request.tool_choice).toBe("required");
  expect(request.tools[0].filters.allowed_domains).toContain("fda.gov.tw");
});
it.each([
  "https://ntuh.gov.tw.attacker.test/x",
  "https://attacker.test/?ntuh.gov.tw",
  "http://ntuh.gov.tw/x",
  "https://user:pass@ntuh.gov.tw/x",
  "javascript:alert(1)",
  "https://127.0.0.1/",
  "https://ntuh.gov.tw:1234/x",
])("rejects untrusted source %s", (u) =>
  expect(reliableReferenceUrl(u)).toBeUndefined(),
);
it("requires a completed actual web search, relevant text, and provider citation metadata", () => {
  const text = "SYNTHETIC 的合成資訊。 [1]\n";
  const raw = {
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: [
              {
                type: "url_citation",
                url,
                title: "合成來源",
                start_index: 17,
                end_index: 20,
              },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseReferenceSearch(raw, [drug]);
  expect(parsed.state).toBe("found");
  expect(parsed.sources[0].url).toBe(url);
  expect(parsed.passages).toHaveLength(1);
  expect(
    parseReferenceSearch({ ...raw, output: raw.output.slice(1) }, [drug]).state,
  ).toBe("unavailable");
  expect(
    parseReferenceSearch(raw, [
      {
        ...drug,
        ingredients: ["UNRELATED"],
        nameZh: "別的名稱",
        nameEn: "Other medicine",
      },
    ]).state,
  ).toBe("not_found");
  raw.output[1].content![0].annotations![0].url = "https://evil.test/";
  expect(parseReferenceSearch(raw, [drug]).sources).toEqual([]);
});
it("separates retrieved-reference assistance from leaflet evidence and never manufactures a quiz", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce({ status: "answered", claims: [claim] })
    .mockResolvedValueOnce({ decisions: [{ id: "0", supported: true }] });
  const result = await assisted(
    { json, searchReferences: async () => search },
    "一般用途？",
    [med],
    [drug],
    [null],
  );
  expect(result.status).toBe("supported");
  expect(result.claims).toEqual([]);
  expect(result.chunks).toEqual([]);
  expect(result.quiz).toEqual([]);
  expect(result.sourceVersions).toEqual({});
  expect(result.assistance?.claims).toEqual([
    { text: claim.text, basis: claim.basis, sourceIds: claim.sourceIds },
  ]);
  expect(result.assistance?.uncertainties.join("")).toContain("不同廠牌");
});
it.each([
  ["AMOXICILLIN (TRIHYDRATE)", true],
  ["AMOXICILLIN TRIHYDRATE", true],
  ["AMOXICILLIN (UNRELATED COMPOUND)", false],
  ["AMOXICILLIN / OTHER INGREDIENT (TRIHYDRATE)", false],
])(
  "matches a known hydrate suffix without discarding arbitrary composition: %s",
  (ingredient, expected) => {
    const text = "Amoxicillin 的來源內容。[1]";
    const raw = {
      status: "completed",
      output: [
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text,
              annotations: [
                {
                  type: "url_citation",
                  url,
                  start_index: text.indexOf("[1]"),
                  end_index: text.length,
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReferenceSearch(raw, [
      { ...drug, ingredients: [ingredient as string] },
    ]);
    expect(parsed.state).toBe(expected ? "found" : "not_found");
    expect(parsed.passages).toHaveLength(expected ? 1 : 0);
  },
);
it("retains cited ingredient information under its heading without carrying context into another drug section", () => {
  const text =
    "## SYNTHETIC OXALATE\n一般注意事項合成內容。[1]\n## OTHER MEDICINE\n不相關內容。[2]\n";
  const raw = {
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: ["[1]", "[2]"].map((marker) => ({
              type: "url_citation",
              url,
              title: "C:\\private\\report.pdf",
              start_index: text.indexOf(marker),
              end_index: text.indexOf(marker) + marker.length,
            })),
          },
        ],
      },
    ],
  };
  const parsed = parseReferenceSearch(raw, [drug]);
  expect(parsed.passages).toHaveLength(1);
  expect(parsed.passages[0].text).toContain("SYNTHETIC OXALATE");
  expect(parsed.passages[0].text).toContain("一般注意事項");
  expect(parsed.sources[0].kind).toBe("hospital");
  expect(parsed.sources[0].title).not.toContain("private");
});
it.each(["not_found", "unavailable"] as const)(
  "keeps user-label AI available when retrieval is %s",
  async (state) => {
    const label = {
      text: "你記錄的 QD 是每日一次的縮寫。",
      basis: "user_label",
      sourceIds: [],
    };
    const json = vi
      .fn()
      .mockResolvedValueOnce({ status: "answered", claims: [label] })
      .mockResolvedValueOnce({ decisions: [{ id: "0", supported: true }] });
    const result = await assisted(
      {
        json,
        searchReferences: async () => ({ state, sources: [], passages: [] }),
      },
      "QD？",
      [med],
      [drug],
      [null],
    );
    expect(result.assistance?.claims).toHaveLength(1);
    expect(result.assistance?.claims[0]).toMatchObject({
      basis: "user_label",
      sourceIds: [],
    });
    expect(result.assistance?.claims[0].text).toContain("每日一次");
    expect(result.assistance?.searchState).toBe(state);
    expect(result.assistance?.sources).toEqual([]);
  },
);
it("drops fabricated citations and reviewer-rejected medical statements", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce({
      status: "answered",
      claims: [claim, { ...claim, sourceIds: ["fake"] }],
    })
    .mockResolvedValueOnce({ decisions: [{ id: "0", supported: false }] });
  const result = await assisted(
    { json, searchReferences: async () => search },
    "用途？",
    [med],
    [drug],
    [null],
  );
  expect(result.assistance?.claims).toEqual([]);
  expect(result.rejectedCount).toBe(2);
});
it.each([
  { evidenceQuotes: [] },
  {
    evidenceQuotes: [
      { sourceId: source.id, quote: "這段文字從未出現在來源原文之中。" },
    ],
  },
])(
  "rejects absent or fabricated verbatim evidence before review",
  async ({ evidenceQuotes }) => {
    const json = vi.fn().mockResolvedValue({
      status: "answered",
      claims: [{ ...claim, evidenceQuotes }],
    });
    const result = await assisted(
      { json, searchReferences: async () => search },
      "用途？",
      [med],
      [drug],
      [null],
    );
    expect(result.assistance?.claims).toEqual([]);
    expect(result.rejectedCount).toBe(1);
    expect(json).toHaveBeenCalledTimes(1);
  },
);
it("withholds personal medication decisions instead of quoting general sources as individual advice", async () => {
  const json = vi
    .fn()
    .mockResolvedValue({ status: "refused", claims: [claim] });
  const result = await assisted(
    { json, searchReferences: async () => search },
    "我可以自己加倍嗎？",
    [med],
    [drug],
    [null],
  );
  expect(result.status).toBe("refused");
  expect(result.assistance?.claims).toEqual([]);
});
it.each(["found", "not_found", "unavailable"] as const)(
  "persists ordinary-user missing-leaflet results for %s, protects ownership, and expires them after a new leaflet is published",
  async (state) => {
    const store = new MemoryStore();
    const json = vi
      .fn()
      .mockImplementation(async (_: string, content: any) =>
        content.expectedIds
          ? { decisions: [{ id: "0", supported: true }] }
          : { status: "answered", claims: [claim] },
      );
    const d = new Domain(store, undefined, () => ({
      json,
      searchReferences: async () =>
        state === "found" ? search : { state, sources: [], passages: [] },
    }));
    d.catalog.all = async () => [drug];
    d.catalog.get = async () => drug;
    d.enqueue = async () => {};
    await d.account({
      uid: "owner",
      email: "synthetic@example.invalid",
      name: "合成測試",
      admin: false,
      verified: true,
    });
    const saved = await d.saveMedication("owner", {
      ...med,
      identityEvidence: { method: "license", printedLicenseNo: drug.licenseNo },
    });
    for (const kind of ["bundle", "chat"] as const) {
      const input = { medicationIds: [saved.id], question: "一般用途？" };
      await d.preflightTextSources(
        "owner",
        true,
        kind,
        input,
        "missing-" + kind,
      );
      const job = await d.enqueueJob(
        "owner",
        true,
        kind,
        input,
        "missing-" + kind,
      );
      await d.processJob(job.id);
      const complete = (await store.get("jobs", job.id))!;
      expect(complete.status).toBe("succeeded");
      expect(
        (await d.publicJob("owner", complete as any)).result,
      ).toHaveProperty("assistance");
      const record = (await store.get(
        kind === "chat" ? "chats" : "learning",
        job.id,
      ))!;
      expect(await d.learningCurrent("owner", record)).toBe(true);
      expect(
        await d.learningCurrent("owner", {
          ...record,
          result: {
            ...record.result,
            assistance: {
              ...record.result.assistance,
              version: "reliable-reference-v3",
            },
          },
        }),
      ).toBe(false);
      expect(
        await d.learningCurrent("owner", {
          ...record,
          result: {
            ...record.result,
            assistance: {
              ...record.result.assistance,
              expiresAt: "2020-01-01",
            },
          },
        }),
      ).toBe(false);
      await expect(
        d.preflightTextSources("other", true, kind, input, "other-key"),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await store.set("published", hash(drug.licenseNo), { leafletId: "new" });
    await store.set("leaflets", "new", {
      licenseNo: drug.licenseNo,
      status: "published",
    });
    expect(
      await d.learningCurrent("owner", (await store.list("learning"))[0]),
    ).toBe(false);
  },
);
