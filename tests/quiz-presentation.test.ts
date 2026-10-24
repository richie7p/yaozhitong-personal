import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sharedQuizPresentation } from "../src/quiz-presentation";

const saved = JSON.parse(readFileSync(new URL("./fixtures/quiz-presentation-saved-source.json", import.meta.url), "utf8"));
const copy = () => structuredClone(saved);

describe("reversible presentation of an already-saved long source question", () => {
  it("retains the complete fifth item, its condition and every surrounding source word", () => {
    const original = JSON.stringify(saved);
    const view = sharedQuizPresentation(saved)!;
    expect(view).toBeDefined();
    expect(view.question).toBe("依仿單「注意事項」欄，以下哪項與原文相符？");
    expect(view.contextBefore).toContain("除非有醫師藥師藥劑生指示");
    expect(view.contextBefore).toContain("五、服藥後若有不適情況發生");
    expect(view.contextAfter).toContain("六、本藥不得與含酒精飲料併服。");
    view.options.forEach((option, index) => {
      expect(option).toContain("五、服藥後若有不適情況發生,");
      expect(option.trim()).toMatch(/^五、.+。$/u);
      expect(option).not.toContain("四、");
      expect(view.prefix + option + view.suffix).toBe(saved.options[index]);
      expect(Buffer.from(view.prefix + option + view.suffix)).toEqual(Buffer.from(saved.options[index]));
    });
    expect(JSON.stringify(saved)).toBe(original);
    expect(sharedQuizPresentation({ ...saved, answer: 0 } as typeof saved)).toEqual(sharedQuizPresentation({ ...saved, answer: 1 } as typeof saved));
  });

  it("keeps the full quoted question scope visibly available without using commas as item boundaries", () => {
    const view = sharedQuizPresentation(saved)!;
    const topic = saved.q.match(/關於「(.+)」，以下/u)[1];
    expect(view.contextBefore).toContain(topic);
    expect(view.prefix).not.toContain("五、");
    expect(saved.options.every((option: string) => option.startsWith(view.contextBefore))).toBe(true);
  });

  it.each([
    ["unrecognized question", (q: typeof saved) => { q.q = "請問下面哪一句比較好？"; }],
    ["other section", (q: typeof saved) => { q.sourceSection = "禁忌"; }],
    ["model explanation", (q: typeof saved) => { q.explanationKind = "verified_plain_language"; }],
    ["other scope", (q: typeof saved) => { q.assessmentScope = "whole_field"; }],
    ["three options", (q: typeof saved) => { q.options.push(q.options[0]); }],
    ["identical options", (q: typeof saved) => { q.options[1] = q.options[0]; }],
    ["short choices", (q: typeof saved) => { q.options = ["不建議使用。", "建議使用。"]; }],
    ["unbalanced parentheses", (q: typeof saved) => { q.options = q.options.map((s: string) => "（" + s); }],
    ["different conditions", (q: typeof saved) => { q.options[1] = q.options[1].replace("若有不適", "若有嚴重不適"); }],
    ["different exception", (q: typeof saved) => { q.options[1] = q.options[1].replace("除非有", "只有"); }],
    ["AND versus OR", (q: typeof saved) => { q.options[1] = q.options[1].replace("孕婦及授乳婦", "孕婦或授乳婦"); }],
    ["two changed sentences", (q: typeof saved) => { q.options[1] = q.options[1].replace("六、本藥不得", "六、本藥可以"); }],
    ["damaged UTF16", (q: typeof saved) => { q.options[0] += "\ud800"; }],
  ])("falls back unchanged for %s", (_reason, change) => {
    const q = copy(); change(q);
    const before = JSON.stringify(q);
    expect(sharedQuizPresentation(q)).toBeUndefined();
    expect(JSON.stringify(q)).toBe(before);
  });

  it("does not split punctuation inside balanced parentheses or a valid surrogate pair", () => {
    const q = copy();
    const replace = (text: string) => text.replace("為防止兒童誤食", "𠮷🙂為防止兒童誤食（甲。與乙）");
    q.q = replace(q.q); q.options = q.options.map(replace);
    const view = sharedQuizPresentation(q)!;
    expect(view).toBeDefined();
    expect(view.contextBefore).toContain("𠮷🙂為防止兒童誤食（甲。與乙）");
    view.options.forEach((option, index) => expect(view.prefix + option + view.suffix).toBe(q.options[index]));
  });

  it("never presents a bare negation or an empty option", () => {
    const q = copy();
    const prefix = q.options[0].slice(0, q.options[0].indexOf(" 五、"));
    q.options = [prefix + "不。", prefix + "。"];
    expect(sharedQuizPresentation(q)).toBeUndefined();
  });
});
