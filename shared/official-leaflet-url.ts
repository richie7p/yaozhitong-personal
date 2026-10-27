// Only server-verified published sources may use these links. This check is
// also applied when rendering persisted results; it does not verify a source.
const officialLeafletHosts = new Set([
  "mcp.fda.gov.tw",
  "info.fda.gov.tw",
  "www.fda.gov.tw",
  "fda.gov.tw",
]);

export function officialLeafletUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !officialLeafletHosts.has(url.hostname) ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
