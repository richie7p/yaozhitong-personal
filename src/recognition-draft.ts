/** Prefill only an explicit frequency label; never infer from a drug or raw text. */
export function recognitionDraftFlags(frequencyRaw: unknown) {
  const frequency = typeof frequencyRaw === "string" ? frequencyRaw.trim() : "";
  return {
    prn: /^(?:PRN|(?:需要時|必要時)(?:(?:才)?(?:服用|使用))?)$/i.test(frequency),
    confirmed: false,
  };
}
