/** Call only after known PRN usage is complete; retain conditional/code warnings. */
export function withoutMissingFrequencyGuidance(guidance: string): string {
  const parts = guidance.split(/([，,。；;\n])/u);
  for (let index = 0; index < parts.length; index += 2) {
    if (
      /^\s*(?:頻次(?:欄(?:位)?)?|頻率(?:欄(?:位)?)?|用藥頻次|服用頻次)(?:尚未明確|未見明確標示|未明確標示|未見標示|未標示|未明確|不明確|不清楚|不清晰|未能辨識|無法辨識|缺漏|缺少|不明)\s*$/u.test(
        parts[index],
      )
    ) {
      parts[index] = "";
      if (index + 1 < parts.length) parts[index + 1] = "";
    }
  }
  return parts
    .join("")
    .replace(/^[，,。；;\s]+|[，,；;\s]+$/gu, "")
    .trim();
}
