/** Recover a printed duration, never a supply count, date, limit or recommendation. */
export function missingLiteralDuration(rawText: string): number | null {
  const text = rawText.normalize("NFKC");
  // These headings can govern several later segments, not just the next field.
  if (
    /教學|範例|例如|示例|假設|建議|最多|最長|上限|至多|不超過|參考|一般用法|通常/u.test(
      text,
    )
  )
    return null;
  const values = new Set<number>();
  let resolvedFields = 0;
  const unsafe =
    /建議|最多|最長|上限|至多|不超過|不得|不可|切勿|不宜|範例|例如|示例|假設|教學|症狀|病史|年齡|歲|包裝|發藥|總量|供應|日期|回診|保存|貯存|有效|效期|未勾選|未選|[□☐☑☒✓✔]/u;
  const segments = text.split(/[;；|\r\n。]/u);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const markers = [
      ...segment.matchAll(
        /療程(?:天數)?\s*[:：]?\s*(?:共)?|共(?=\s*[-+.\d])/gu,
      ),
    ];
    if (!markers.length) continue;
    // A preceding annotation heading can scope the following field too.
    if (unsafe.test(segment) || unsafe.test(segments[index - 1] || ""))
      return null;
    for (const marker of markers) {
      const prefix = segment.slice(0, marker.index);
      if (!/(?:^|[，,:：])\s*$/u.test(prefix)) return null;
      const rest = segment.slice(marker.index! + marker[0].length);
      const printed = rest.match(/^\s*([1-9]\d*)\s*天(?=\s*(?:[，,]|$))/u);
      if (!printed) return null;
      const tail = rest.slice(printed[0].length);
      if (
        /^\s*[,，]?\s*(?:或|至|到|改|調整|[-~～])/u.test(tail) ||
        /\d\s*天/u.test(tail)
      )
        return null;
      if (
        marker[0].startsWith("共") &&
        !/^\s*(?:用法(?:用量)?|使用方法|服用方式)\s*[:：]/u.test(segment) &&
        !/每次(?:用量|劑量)?\s*[:：]?\s*(?:\d+(?:\.\d+)?\s*(?:粒|錠|顆|包|毫升|ml|滴|噴|公克|克|g)|適量|薄薄一層)\s*(?=[，,]|$)/iu.test(
          segment,
        )
      )
        return null;
      const days = Number(printed[1]);
      if (!Number.isSafeInteger(days)) return null;
      values.add(days);
      resolvedFields++;
    }
  }
  // An alternative, limit or unexplained day count in a different segment must
  // not be silently ignored while selecting the apparently clear field.
  const dayMentions = [...text.matchAll(/\d(?:[\d.\s]*\d)?\s*天/gu)].length;
  return values.size === 1 && dayMentions === resolvedFields
    ? [...values][0]
    : null;
}

/** Remove only a missing-duration subject after every final duration is known. */
export function withoutMissingDurationGuidance(guidance: string): string {
  const durationLabels = new Set([
    "療程",
    "療程天數",
    "天數",
    "用藥天數",
    "服藥天數",
    "服用天數",
    "使用天數",
  ]);
  const parts = guidance.split(/([，,。；;\n])/u);
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index].match(
      /^(\s*)(.+?)(尚未明確|未見明確標示|未明確標示|未見標示|未標示|未明確|不明確|不清楚|不清晰|未能辨識|無法辨識|缺漏|缺少|不明)(.*)$/u,
    );
    if (!clause) continue;
    const subjects = clause[2].split(/\s*[、及與和或/／]\s*/u);
    const remaining = subjects.filter(
      (subject) => !durationLabels.has(subject.trim()),
    );
    if (subjects.length === remaining.length) continue;
    if (remaining.length)
      parts[index] = clause[1] + remaining.join("、") + clause[3] + clause[4];
    else {
      // Do not discard an unrelated warning attached to the same clause.
      if (clause[4].trim()) continue;
      parts[index] = "";
      if (index + 1 < parts.length) parts[index + 1] = "";
    }
  }
  return parts
    .join("")
    .replace(/^[，,。；;\s]+|[，,；;\s]+$/gu, "")
    .trim();
}
