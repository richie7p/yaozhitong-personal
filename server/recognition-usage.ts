/** Detect contradictory literal administration labels, without inferring a drug's route. */
export function recognitionUsageConflict(rawText: string): boolean {
  const text = rawText.normalize("NFKC").replace(/\s/gu, "");
  const affirmative = (pattern: RegExp) =>
    [...text.matchAll(pattern)].some((match) => {
      const prefix =
        text
          .slice(0, match.index)
          .split(/[;；。\n，,]/u)
          .at(-1) || "";
      // "外用，禁止口服" is an explicit prohibition, not two competing routes.
      return !/(?:不可|不得|禁止|嚴禁|切勿|勿|非)(?:[^;；。，,]{0,10})$/u.test(
        prefix,
      );
    });
  return (
    affirmative(/外用|外敷/gu) && affirmative(/口服|內服|[飯餐](?:前|後)服用/gu)
  );
}

/** Nulls must not be filled by interpreting examples or choosing checkboxes. */
export function usageRecoveryBlocked(rawText: string): boolean {
  return /教學|範例|例如|示例|假設|[□☐☑☒✓✔]|\[\s*[xXvV]?\s*\]|未勾|未選/u.test(
    rawText.normalize("NFKC"),
  );
}

/** A product title or a request to contact a clinician is not a frequency. */
export function prescriptionFrequencyContext(
  rawText: string,
  index: number,
  frequency: string,
): boolean {
  const text = rawText.normalize("NFKC");
  const prefix =
    text
      .slice(0, index)
      .split(/[;；|。！？\r\n]/u)
      .at(-1) || "";
  if (
    /(?:藥名|品名|商品名|藥品(?:名稱|學名)?|成分|含量|規格|包裝|備註|注意事項|警語|諮詢)\s*[:：]/u.test(
      prefix,
    ) ||
    /備註|注意事項|諮詢/u.test(prefix)
  )
    return false;
  return !/^\s*(?:請|可|應|需|須)?\s*(?:洽|聯絡|諮詢|詢問|就醫|回診)/u.test(
    text.slice(index + frequency.length),
  );
}

/** Keep dose evidence outside product headings, dispensing totals and containers. */
export function numericDoseSourceText(
  rawText: string,
  name: string,
  strength: string | null,
): string {
  if (usageRecoveryBlocked(rawText)) return "";
  const compact = (value: string) =>
    value.normalize("NFKC").replace(/\s/gu, "").toLowerCase();
  return rawText
    .normalize("NFKC")
    .split(/[;；|。\r\n]/u)
    .map((field) => {
      const dose =
        /每次(?:用量|劑量)?|每回(?:用量|劑量)?|(?:用量|劑量|dose(?:\s+amount)?)\s*[:：]/iu.exec(
          field,
        );
      const metadata =
        /^\s*(?:藥名|品名|商品名|藥品(?:名稱|學名)?|成分|含量|規格|包裝(?:容量|數量)?|容量|發藥(?:總量|量)?|總量|備註|注意事項|警語)\s*(?:[:：]|(?=\d))/u.test(
          field,
        );
      if (metadata && !dose) return "";
      if (dose) field = field.slice(dose.index);
      field = field.split(
        /(?:發藥(?:總量|量)?|總量|包裝(?:容量|數量)?|容量)\s*[:：]?/u,
      )[0];
      field = field
        .replace(
          /(?<![\dA-Za-z.])\d+(?:\.\d+)?\s*(?:ml|gm|g|l|毫升|公克|克|公升)\s*\/\s*(?:bottle|bot|tube|瓶|管)(?=\s|[();；。，,（）]|外用|口服|內服|$)/giu,
          "",
        )
        .replace(
          /(?<![\dA-Za-z.])\d+(?:\.\d+)?\s*(?:mcg|μg|mg|g|微克|毫克|公克)\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:gm|g|ml|公克|毫升)(?![A-Za-z])/giu,
          "",
        );
      let evidence = compact(field);
      if (!dose) {
        if (name) evidence = evidence.replace(compact(name), "");
        if (strength) evidence = evidence.replace(compact(strength), "");
      }
      return evidence;
    })
    .join(";");
}

/** Reject only an amount explicitly printed with a container, without conversion. */
export function isContainerAmountStrength(
  rawText: string,
  supplied: string,
): boolean {
  const compact = (value: string) =>
    value.normalize("NFKC").replace(/\s/gu, "").toLowerCase();
  const amount = compact(supplied).match(
    /^(\d+(?:\.\d+)?)(ml|gm|g|l|毫升|公克|克|公升)(?:\/(?:bottle|bot|tube|瓶|管))?$/iu,
  );
  if (!amount) return false;
  const escaped = [amount[1], amount[2]]
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(
    `(?<![\\dA-Za-z.])${escaped}\\s*/\\s*(?:bottle|bot|tube|瓶|管)(?=\\s|[();；。，,（）]|外用|口服|內服|$)`,
    "iu",
  ).test(rawText.normalize("NFKC"));
}

/**
 * A concentration and a separately printed container amount are different
 * fields. Strip only the third/fourth slash segments when the original text
 * explicitly supplies both a container amount and its container label.
 * No unit conversion, ingredient lookup or prescribed-dose inference occurs.
 */
export function concentrationWithoutPackage(
  rawText: string,
  suppliedStrength: string,
): string | null {
  const normalize = (value: string) =>
    value.normalize("NFKC").replace(/\s/gu, "").toLowerCase();
  const supplied = normalize(suppliedStrength);
  const text = rawText.normalize("NFKC");
  const patterns =
    /(?<![\dA-Za-z.+/−-])((\d+(?:\.\d+)?)\s*(?:mcg|μg|mg|g|微克|毫克|公克)\s*\/\s*(?:(\d+(?:\.\d+)?)\s*)?(?:gm|g|ml|公克|毫升))\s*\/\s*(\d+(?:\.\d+)?)\s*(?:ml|gm|g|毫升|公克)\s*\/\s*(?:bottle|bot|tube|瓶|管)(?=\s|[();；。，,（）]|外用|口服|內服|$)/giu;
  const matches = [...text.matchAll(patterns)].filter((match) => {
    if (
      /[−-]\s*$/u.test(text.slice(0, match.index)) ||
      Number(match[2]) <= 0 ||
      (match[3] !== undefined && Number(match[3]) <= 0) ||
      Number(match[4]) <= 0
    )
      return false;
    const full = normalize(match[0]);
    const withoutContainer = full.replace(/\/(?:bottle|bot|tube|瓶|管)$/u, "");
    return supplied === full || supplied === withoutContainer;
  });
  const concentrations = new Set(matches.map((match) => normalize(match[1])));
  return concentrations.size === 1 ? matches[0][1].trim() : null;
}
