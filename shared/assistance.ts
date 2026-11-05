/** Separate from the site's reviewed, versioned leaflet evidence. */
export const ASSISTANCE_VERSION = "reliable-reference-v7";
/** Verified hospital domains, shared by retrieval and source attribution. */
export const HOSPITAL_REFERENCE_DOMAINS = [
  "ntuh.gov.tw",
  "vghtpe.gov.tw",
  "cgmh.org.tw",
  "cth.org.tw",
  "mmh.org.tw",
  "cmuh.cmu.edu.tw",
  "cmuh.org.tw",
  "tmuh.org.tw",
  "tpech.gov.tw",
  "mercy.org.tw",
  "knh.org.tw",
  "chimei.org.tw",
  "shmc.ntu.edu.tw",
] as const;
export const REFERENCE_DOMAINS = [
  "fda.gov.tw",
  "mohw.gov.tw",
  "gov.taipei",
  ...HOSPITAL_REFERENCE_DOMAINS,
  "medlineplus.gov",
  "nhs.uk",
  "fda.gov",
  "dailymed.nlm.nih.gov",
] as const;
export function reliableReferenceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !REFERENCE_DOMAINS.some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      )
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
export interface ReferenceSource {
  id: string;
  title: string;
  url: string;
  kind: "official" | "hospital" | "indexed_leaflet";
}
export interface ReferencePassage {
  text: string;
  sourceIds: string[];
}
export interface ReferenceSearch {
  state: "found" | "not_found" | "unavailable";
  sources: ReferenceSource[];
  passages: ReferencePassage[];
}
export interface Assistance {
  version: typeof ASSISTANCE_VERSION;
  checkedAt: string;
  expiresAt: string;
  searchState: ReferenceSearch["state"];
  missingLicenses: string[];
  sources: ReferenceSource[];
  claims: {
    text: string;
    sourceIds: string[];
    basis: "reference" | "user_label";
  }[];
  uncertainties: string[];
}
