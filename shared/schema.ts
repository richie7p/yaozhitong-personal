import { z } from "zod";
export const ProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  age: z.number().int().min(0).max(120).nullable().default(null),
  sex: z.enum(["unspecified", "female", "male"]).default("unspecified"),
  conditions: z.array(z.string().max(60)).max(20).default([]),
  allergies: z.string().max(500).default(""),
  pregnancy: z
    .enum(["unknown", "no", "pregnant", "lactating"])
    .default("unknown"),
  notes: z.string().max(1000).default(""),
  notifyFamily: z.boolean().default(false),
  timezone: z.literal("Asia/Taipei").default("Asia/Taipei"),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const MedicationSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    licenseNo: z.string().max(80).nullable().default(null),
    strength: z.string().max(80).default(""),
    form: z.string().max(50).default(""),
    doseAmount: z.number().positive().max(10000).nullable().default(null),
    doseUnit: z.string().max(30).default(""),
    doseText: z.string().trim().max(100).default(""),
    frequencyRaw: z.string().max(100).default(""),
    route: z.string().max(60).default(""),
    rawText: z.string().max(1500).default(""),
    durationDays: z.number().int().positive().nullable().default(null),
    instructions: z.string().max(500).default(""),
    confirmed: z.boolean().default(false),
    prn: z.boolean().default(false),
  })
  .superRefine((m, c) => {
    if (m.doseText && (m.doseAmount !== null || !!m.doseUnit.trim()))
      c.addIssue({
        code: "custom",
        message: "數字劑量與用量原文請擇一填寫，避免保存互相衝突的用量。",
      });
    const numeric = !!m.doseAmount && !!m.doseUnit.trim();
    const literal =
      !!m.doseText.trim() && m.doseAmount === null && !m.doseUnit.trim();
    if (
      m.confirmed &&
      ((!numeric && !literal) ||
        (numeric && !!m.doseText) ||
        !m.frequencyRaw.trim())
    )
      c.addIssue({
        code: "custom",
        message:
          "請確認數字劑量與單位，或填入藥袋用量原文，並確認頻次後再完成建檔。",
      });
  });
export type Medication = Omit<z.infer<typeof MedicationSchema>, "doseText"> & {
  /** Older saved numeric prescriptions may not have this field. */
  doseText?: string;
  id: string;
  ownerId: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ScheduleSchema = z.object({
  medicationId: z.string().min(1).max(80),
  times: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .min(1)
    .max(8)
    .transform((x) => [...new Set(x)].sort()),
  startDate: date,
  endDate: date.nullable().default(null),
  timezone: z.literal("Asia/Taipei").default("Asia/Taipei"),
});
export type Schedule = z.infer<typeof ScheduleSchema> & {
  id: string;
  ownerId: string;
  medicationRevision: number;
  active: boolean;
  nextAt: string | null;
};
export const CabinetSchema = z.object({
  name: z.string().trim().min(1).max(150),
  medicationId: z.string().max(80).nullable().default(null),
  quantity: z.number().nonnegative().max(100000),
  unit: z.string().min(1).max(30),
  expiresAt: date.nullable().default(null),
  disposed: z.boolean().default(false),
});
export interface Drug {
  licenseNo: string;
  nameZh: string;
  nameEn: string;
  strength: string;
  form: string;
  ingredients: string[];
  revoked: boolean;
}
export interface Chunk {
  id: string;
  licenseNo: string;
  version: string;
  page: number;
  start: number;
  text: string;
}
export interface Leaflet {
  id: string;
  licenseNo: string;
  version: string;
  sourceUrl: string;
  sha256: string;
  storagePath: string;
  chunks: Chunk[];
  status: "draft" | "published" | "retired";
  checkedBy: string | null;
  checkedAt: string | null;
}
export interface Citation {
  chunkId: string;
  quote: string;
}
export const ClaimCategorySchema = z.enum([
  "purpose",
  "use",
  "warning",
  "other",
]);
export const ProfileReferenceSchema = z.object({
  field: z.enum(["age", "sex", "conditions", "allergies", "pregnancy"]),
  value: z.string().min(1).max(500),
});
export type ProfileReference = z.infer<typeof ProfileReferenceSchema>;
export interface Claim {
  text: string;
  citations: Citation[];
  kind?: string;
  category?: z.infer<typeof ClaimCategorySchema>;
  profileRefs?: ProfileReference[];
  /** Backend-derived literal condition mentions; this is not clinical applicability. */
  sourceMentions?: ProfileReference[];
}
export interface GroundedResult {
  status: "supported" | "not_found" | "insufficient_data" | "refused";
  claims: Claim[];
  chunks: Chunk[];
  quiz: {
    id: string;
    q: string;
    options: string[];
    answer: number;
    explain: string;
    explanationKind?: "source_quote";
    citations: Citation[];
  }[];
  followups: { question: string; claimIndex: number }[];
  rejectedCount: number;
  sourceVersions: Record<string, string>;
  verification: "model_assisted";
}
export interface QuizGrade {
  id: string;
  state: "unanswered" | "incorrect" | "correct";
  correct: boolean;
  answer: number;
  explain: string;
}
export interface LearningProgress {
  total: number;
  answered: number;
  correct: number;
  passed: boolean;
  status: "not_started" | "in_progress" | "completed" | "unavailable";
  results: QuizGrade[];
}
export interface LearningRecord {
  id: string;
  ownerId: string;
  medicationIds: string[];
  medicationRevisions: { id: string; revision: number }[];
  profileVersion: number;
  groundingVersion?: string;
  result: GroundedResult;
  answers: Record<string, number>;
  passed?: boolean;
  progress?: LearningProgress;
  createdAt: string;
}
export type JobKind =
  "recognition" | "chat" | "bundle" | "interaction" | "delete-account";
export interface AiRequestMetric {
  provider: string;
  model: string;
  stage: "vision" | "generation" | "verification";
  attempt: number;
  latencyMs: number;
  status?: number;
  tokens: number | null;
  finishReason?: string;
  error?: string;
  fallbackFrom?: string;
}
export interface Job {
  id: string;
  ownerId: string;
  kind: JobKind;
  status: "queued" | "running" | "succeeded" | "failed";
  input: Record<string, unknown>;
  result: unknown;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  leaseUntil: number;
  attempts: number;
  savedMedications?: Record<string, { id: string; name: string }>;
  localWorkerPid?: number;
  localWorkerBootTime?: number;
  tokens?: number;
  latencyMs?: number;
  aiRequests?: AiRequestMetric[];
}
export interface Account {
  id: string;
  email: string;
  displayName: string;
  admin: boolean;
  eligible: boolean;
  disabled: boolean;
  deleting: boolean;
  profileVersion: number;
  createdAt: string;
}
export interface Identity {
  uid: string;
  email: string;
  name: string;
  verified: boolean;
  admin: boolean;
}
