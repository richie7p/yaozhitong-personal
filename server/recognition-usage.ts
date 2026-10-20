/** Detect contradictory literal administration labels, without inferring a drug's route. */
export function recognitionUsageConflict(rawText: string): boolean {
  const text = rawText.normalize("NFKC").replace(/\s/gu, "");
  const affirmative = (pattern: RegExp) => [...text.matchAll(pattern)].some(match => {
    const prefix = text.slice(0, match.index).split(/[;；。\n，,]/u).at(-1) || "";
    // "外用，禁止口服" is an explicit prohibition, not two competing routes.
    return !/(?:不可|不得|禁止|嚴禁|切勿|勿|非)(?:[^;；。，,]{0,10})$/u.test(prefix);
  });
  return affirmative(/外用|外敷/gu) &&
    affirmative(/口服|內服|[飯餐](?:前|後)服用/gu);
}
