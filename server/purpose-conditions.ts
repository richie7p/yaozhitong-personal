import { warningConditions, warningConditionsPreserved } from "../shared/learning.js";

const compact = (value: string) => value.normalize("NFKC").replace(/\s/gu, "");
/** Purpose wording may insert the grammatical 的 after 所引起, only when the
 * entire original 因<cause>所引起<object> span is otherwise unchanged. No
 * synonyms, missing subjects, original 之/的 replacements or warning relaxation. */
export function purposeConditionsPreserved(text: string, quotes: string[]) {
  if (warningConditionsPreserved(text, quotes)) return true;
  const target = compact(text);
  return warningConditions(quotes).every((condition) => {
    if (target.includes(condition)) return true;
    if (!/^所引起(?![之的])/u.test(condition)) return false;
    return quotes.some((quote) => [...compact(quote).matchAll(
      /因([^，,。；;！？!?]{1,120}?)所引起(?![之的])([^，,。；;！？!?]{1,120})/gu,
    )].some((span) => {
      if ("所引起" + span[2] !== condition) return false;
      const body = compact(quote)
        .replace(/^(?:\d+(?:\.\d+)*[.、]?)?(?:【)?(?:用途[（(]適應症[）)]|適應症|效能)(?:】)?[:：]?/u, "")
        .replace(/[。！？.!?]+$/u, "");
      // Preserve every other part of this purpose field, including any age,
      // restriction, exception or additional indication around the cause.
      return target.includes(body.replace(span[0], "因" + span[1] + "所引起的" + span[2]));
    }));
  });
}
