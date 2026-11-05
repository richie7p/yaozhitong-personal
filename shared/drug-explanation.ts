import { z } from "zod";
import type { Drug, GroundedResult } from "./schema.js";

/** Public label fields only: no prescription, patient details, or free-text notes. */
export const DrugQuerySchema = z.object({
  name: z.string().trim().min(1).max(150),
  strength: z.string().trim().max(80).default(""),
  form: z.string().trim().max(50).default(""),
  licenseNo: z.string().trim().max(80).optional(),
}).strict();
export const DrugExplanationRequestSchema = z.union([
  z.object({ medicationId: z.string().min(1).max(80) }).strict(),
  z.object({
    recognitionId: z.string().min(1).max(80),
    medicationIndex: z.number().int().min(0).max(19),
  }).strict(),
  z.object({ query: DrugQuerySchema }).strict(),
]);
export type DrugExplanationRequest = z.infer<typeof DrugExplanationRequestSchema>;
export type DrugQuery = z.infer<typeof DrugQuerySchema>;
export interface ReferenceProduct extends Drug {
  /** False means literal label search, never an independently verified product. */
  identityVerified?: boolean;
  queriedName?: string;
  catalogReference?: DrugCatalogReference;
}
export const GENERAL_CATALOG_SOURCE =
  "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=36&logType=5";
export interface DrugCatalogReference {
  sourceUrl: string;
  catalogVersion: string;
  licenseNo: string;
  nameZh: string;
  nameEn: string;
  strength: string;
  form: string;
  ingredients: string[];
  matchBasis: "complete_name" | "complete_name_and_strength";
}
export const DRUG_EXPLANATION_VERSION = "general-drug-information-v1";
export interface DrugExplanationResult extends GroundedResult {
  mode: "general_information";
  explanationVersion: typeof DRUG_EXPLANATION_VERSION;
  queriedProduct: DrugQuery;
  identityStatus: "unverified" | "confirmed";
  catalogReference?: DrugCatalogReference;
}
