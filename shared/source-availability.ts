import type { OfficialSourceReference } from "./schema.js";

/** Source inspection is read-only and does not create an AI task. */
export interface MedicationSourceInfo {
  medicationId: string;
  medicationRevision: number;
  state: "available" | "needs_review" | "missing";
  sources: OfficialSourceReference[];
}
