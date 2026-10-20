/** Local-only manifest and evidence checks for independently supplied photographs. */
import { z } from "zod";
import { isAbsolute, relative, resolve } from "node:path";
import type { Drug, GroundedResult, Leaflet } from "../shared/schema.js";

const literal = z.union([z.string(), z.number(), z.null()]);
const expectedFields = z
  .object({
    name: literal.optional(),
    strength: literal.optional(),
    doseAmount: literal.optional(),
    doseText: literal.optional(),
    doseUnit: literal.optional(),
    frequencyRaw: literal.optional(),
    route: literal.optional(),
    durationDays: literal.optional(),
  })
  .strict();
export const expandedManifestSchema = z
  .object({
    version: z.literal(1),
    fixture: z
      .object({ database: z.string().min(1), blobs: z.string().min(1) })
      .strict(),
    profile: z
      .object({
        age: z.number().int().min(18).max(120).default(32),
        conditions: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,69}$/),
            inputKind: z.enum([
              "real_photo",
              "public_photo",
              "synthetic",
              "transformed",
              "manual_medication",
            ]),
            skipRecognition: z.boolean().default(false),
            image: z.string().min(1).optional(),
            imageSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            notAvailableReason: z.string().min(1).optional(),
            provenance: z
              .object({
                description: z.string().min(1),
                sourceUrl: z.url().optional(),
                permission: z.string().min(1).optional(),
                derivedFrom: z.string().min(1).optional(),
                cameraCaptureAttested: z.boolean().default(false),
              })
              .strict(),
            repeat: z.number().int().min(1).max(3).default(1),
            scope: z.enum(["full_flow", "recognition", "usage_review"]).default("full_flow"),
            reviewNameMustInclude: z.string().min(1).optional(),
            expected: z
              .array(
                z
                  .object({
                    licenseNo: z.string().min(1),
                    fields: expectedFields,
                    fieldAlternatives: z
                      .object({
                        frequencyRaw: z
                          .array(z.string().min(1))
                          .min(1)
                          .max(4)
                          .optional(),
                        strength: z
                          .array(z.string().min(1))
                          .min(1)
                          .max(4)
                          .optional(),
                        route: z
                          .array(z.string().min(1))
                          .min(1)
                          .max(4)
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    rawTextMustInclude: z.array(z.string().min(1)).optional(),
                    /** Predeclared, independently checked complete safety fields. */
                    requiredSafety: z
                      .array(z.object({
                        sourceSection: z.string().min(1),
                        quote: z.string().min(1),
                        body: z.string().min(1),
                      }).strict())
                      .max(40)
                      .optional(),
                    identity: z
                      .object({
                        policy: z.enum([
                          "candidate_only",
                          "visible_brand_supported",
                          "software_fixture",
                        ]),
                        note: z.string().min(1),
                      })
                      .strict()
                      .optional(),
                    /** Only manually transcribed, visible source values may fill a missing OCR field. */
                    confirm: z
                      .object({
                        doseAmount: z.number().positive().nullable(),
                        doseUnit: z.string(),
                        doseText: z.string().optional(),
                        frequencyRaw: z.string().min(1),
                        route: z.string().optional(),
                        durationDays: z
                          .number()
                          .int()
                          .positive()
                          .nullable()
                          .optional(),
                        prn: z.boolean().default(false),
                        sourceNote: z.string().min(1),
                      })
                      .strict()
                      .superRefine((value, ctx) => {
                        if (
                          value.doseAmount === null &&
                          (!value.doseText?.trim() || !!value.doseUnit.trim())
                        )
                          ctx.addIssue({
                            code: "custom",
                            message:
                              "A non-numeric dose needs literal doseText and an empty numeric dose unit.",
                          });
                        if (
                          value.doseAmount !== null &&
                          (!value.doseUnit.trim() || value.doseText?.trim())
                        )
                          ctx.addIssue({
                            code: "custom",
                            message:
                              "A numeric dose requires a unit and no competing doseText.",
                          });
                      })
                      .optional(),
                  })
                  .strict(),
              )
              .max(8),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = manifest.cases.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["cases"],
        message: "Case IDs must be unique.",
      });
    if (manifest.cases.reduce((sum, entry) => sum + entry.repeat, 0) > 15)
      ctx.addIssue({
        code: "custom",
        path: ["cases"],
        message: "A fixed batch may contain at most 15 attempts.",
      });
    for (const [index, entry] of manifest.cases.entries()) {
      if (entry.scope === "usage_review"
        ? entry.expected.length !== 0 || entry.skipRecognition || !entry.reviewNameMustInclude
        : entry.expected.length === 0)
        ctx.addIssue({ code: "custom", path: ["cases", index, "expected"],
          message: "Usage-review photos declare no confirmed identity and require a visible name; normal cases require drug expectations." });
      if (!entry.skipRecognition && !entry.image && !entry.notAvailableReason)
        ctx.addIssue({
          code: "custom",
          path: ["cases", index],
          message: "Missing photographs require a notAvailableReason.",
        });
      if (
        entry.image &&
        ["real_photo", "public_photo"].includes(entry.inputKind) &&
        !entry.provenance.cameraCaptureAttested
      )
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "provenance"],
          message:
            "A real photograph needs a documented camera-capture attestation; synthetic or transformed images must retain their own kind.",
        });
      if (entry.inputKind === "transformed" && !entry.provenance.derivedFrom)
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "provenance"],
          message: "Transformed images require derivedFrom.",
        });
      if (
        entry.image &&
        entry.inputKind === "public_photo" &&
        !entry.provenance.sourceUrl
      )
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "provenance"],
          message: "Public photographs require the original source URL.",
        });
      if (
        entry.skipRecognition !== (entry.inputKind === "manual_medication") ||
        (entry.skipRecognition && entry.image)
      )
        ctx.addIssue({
          code: "custom",
          path: ["cases", index],
          message:
            "Manual medication cases must set skipRecognition:true and have no photograph; photograph cases cannot skip recognition.",
        });
      const licenses = entry.expected.map((row) => row.licenseNo);
      for (const [rowIndex, reference] of entry.expected.entries()) {
        for (const [field, values] of Object.entries(
          reference.fieldAlternatives || {},
        )) {
          const primary =
            reference.fields[field as "frequencyRaw" | "strength" | "route"];
          if (typeof primary !== "string" || !values.includes(primary))
            ctx.addIssue({
              code: "custom",
              path: [
                "cases",
                index,
                "expected",
                rowIndex,
                "fieldAlternatives",
                field,
              ],
              message:
                "Predeclared literal alternatives must include the primary string expectation; a missing/null source field cannot gain a guessed value.",
            });
        }
      }
      if (new Set(licenses).size !== licenses.length)
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "expected"],
          message:
            "Duplicate-license rows require separate cases so row identity is unambiguous.",
        });
    }
  });
export type ExpandedManifest = z.infer<typeof expandedManifestSchema>;
export type ExpandedCase = ExpandedManifest["cases"][number];

/** Storage paths from a database cannot escape its supplied blob root. */
export function fixtureBlob(root: string, storagePath: string) {
  const file = resolve(root, storagePath);
  const rel = relative(resolve(root), file);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../") ||
    isAbsolute(rel)
  )
    throw Error("Unsafe fixture storage path.");
  return file;
}

export function imageMediaType(bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > 8_000_000)
    throw Error("Photograph must be a non-empty JPEG or PNG at most 8 MB.");
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png" as const;
  if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg" as const;
  throw Error(
    "Photograph is not JPEG or PNG; no image conversion is performed by this check.",
  );
}

export function compareRecognition(
  rows: any[],
  expected: ExpandedCase["expected"],
) {
  const comparisons = expected.map((reference) => {
    const matches = rows.filter((row) =>
      row.candidates?.some(
        (drug: Drug) => drug.licenseNo === reference.licenseNo,
      ),
    );
    const actual =
      matches.length === 1
        ? matches[0]
        : rows.length === 1 && expected.length === 1
          ? rows[0]
          : undefined;
    const compact = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
    const rawText = (reference.rawTextMustInclude || []).map((value) => ({
      expected: value,
      passed:
        !!actual &&
        compact(String(actual.rawText || "")).includes(compact(value)),
    }));
    const fields = Object.fromEntries(
      Object.entries(reference.fields).map(([key, value]) => {
        const found = actual?.[key] ?? null;
        const strictMatch = actual !== undefined && value === found;
        const alternatives =
          reference.fieldAlternatives?.[key as "frequencyRaw" | "strength" | "route"];
        const literalInRaw =
          typeof found === "string" &&
          compact(String(actual?.rawText || "")).includes(compact(found));
        const acceptedAlternative =
          !!actual &&
          !!alternatives &&
          typeof found === "string" &&
          alternatives.some((allowed) => compact(allowed) === compact(found)) &&
          literalInRaw;
        return [
          key,
          {
            expected: value,
            actual: found,
            strictMatch,
            alternatives: alternatives || null,
            literalInRaw: alternatives ? literalInRaw : null,
            matchKind:
              strictMatch && (!alternatives || literalInRaw)
                ? "strict_primary"
                : acceptedAlternative
                  ? "predeclared_literal_alternative"
                  : "mismatch",
            passed: alternatives ? acceptedAlternative : strictMatch,
          },
        ];
      }),
    );
    return {
      licenseNo: reference.licenseNo,
      identity: reference.identity || null,
      candidateMatches: matches.length,
      diagnosticRowSelection:
        matches.length === 1
          ? "unique_official_candidate"
          : actual
            ? "single_row_fields_only_identity_still_failed"
            : "unmatched",
      rawText,
      fields,
      fieldsStrictPassed:
        !!actual && Object.values(fields).every((field) => field.strictMatch),
      fieldsPassed:
        !!actual && Object.values(fields).every((field) => field.passed),
      strictPassed:
        matches.length === 1 &&
        !!actual &&
        Object.values(fields).every((field) => field.strictMatch) &&
        rawText.every((item) => item.passed),
      passed:
        matches.length === 1 &&
        !!actual &&
        Object.values(fields).every((field) => field.passed) &&
        rawText.every((item) => item.passed),
    };
  });
  return {
    expectedCount: expected.length,
    actualCount: rows.length,
    comparisons,
    strictPassed:
      rows.length === expected.length &&
      comparisons.every((row) => row.strictPassed),
    passed:
      rows.length === expected.length && comparisons.every((row) => row.passed),
  };
}

export function validateGroundedSource(
  result: GroundedResult,
  source: Leaflet,
  requiredSafety?: { sourceSection: string; quote: string; body: string }[],
) {
  const compact = (value: string) => value.normalize("NFKC").replace(/\s/g, "");
  const checks: { check: string; passed: boolean }[] = [];
  const add = (check: string, passed: boolean) =>
    checks.push({ check, passed });
  add(
    "supported-with-claims-purpose-and-quiz",
    result.status === "supported" &&
      result.claims.length > 0 &&
      result.claims.some((claim) => claim.category === "purpose") &&
      result.quiz.length > 0,
  );
  add(
    "canonical-source-version",
    result.sourceVersions[source.licenseNo] === source.version,
  );
  for (const chunk of result.chunks) {
    const canonical = source.chunks.find(
      (candidate) => candidate.id === chunk.id,
    );
    add(
      "canonical-chunk:" + chunk.id,
      !!canonical &&
        Object.keys(chunk).length === Object.keys(canonical).length &&
        Object.entries(canonical).every(
          ([key, value]) => (chunk as any)[key] === value,
        ),
    );
  }
  for (const [index, claim] of result.claims.entries()) {
    for (const mention of claim.sourceMentions || []) {
      add(
        "literal-own-source-mention:" + index,
        claim.category === "warning" &&
          mention.field === "conditions" &&
          compact(mention.value).length >= 2 &&
          compact(claim.text).includes(compact(mention.value)) &&
          claim.citations.some((citation) =>
            compact(citation.quote).includes(compact(mention.value)),
          ),
      );
    }
  }
  for (const [index, item] of [...result.claims, ...result.quiz].entries()) {
    add("has-citations:" + index, item.citations.length > 0);
    for (const citation of item.citations) {
      const canonical = source.chunks.find(
        (chunk) => chunk.id === citation.chunkId,
      );
      add(
        "exact-source-quote:" + index + ":" + citation.chunkId,
        !!canonical &&
          canonical.licenseNo === source.licenseNo &&
          canonical.version === source.version &&
          !!compact(citation.quote) &&
          compact(canonical.text).includes(compact(citation.quote)),
      );
    }
  }
  for (const question of result.quiz) {
    add(
      "valid-options:" + question.id,
      question.options.length >= 2 &&
        new Set(question.options.map(compact)).size ===
          question.options.length &&
        Number.isInteger(question.answer) &&
        question.answer >= 0 &&
        question.answer < question.options.length,
    );
    const heading =
      /^依仿單「(?:適應症|用途\(適應症\)|效能|警語|警語及注意事項|注意事項|使用上注意事項|副作用|副作用\/不良反應|附記|禁忌|禁忌症|交互作用|過量|藥物過量)」原文：/;
    const lines = question.explain
      .replace(heading, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    add(
      "own-source-explanation:" + question.id,
      question.explanationKind === "source_quote" &&
        heading.test(question.explain) &&
        lines.length > 0 &&
        lines.every((line) =>
          question.citations.some((citation) =>
            compact(citation.quote).includes(compact(line)),
          ),
        ),
    );
  }
  if (requiredSafety) {
    const coverage = result.safetyCoverage;
    add("purpose-understanding-question", result.quiz.some(question =>
      question.learningObjective === "purpose" && result.claims.some(claim =>
        claim.category === "purpose" && claim.citations.length === question.citations.length &&
        claim.citations.every(citation => question.citations.some(support =>
          support.chunkId === citation.chunkId && compact(support.quote) === compact(citation.quote))))));
    add("all-canonical-source-chunks-retained", result.chunks.length === source.chunks.length &&
      source.chunks.every(chunk => result.chunks.some(actual => actual.id === chunk.id)));
    add("declared-safety-counts", !!coverage &&
      coverage.scope === "recognized_source_sections" &&
      coverage.assessmentScope === "one_key_point_per_section" &&
      coverage.sourceSectionCount === requiredSafety.length &&
      coverage.coveredSectionCount === requiredSafety.length &&
      coverage.quizCoveredSectionCount === requiredSafety.length &&
      coverage.sections.length === requiredSafety.length &&
      coverage.status === (requiredSafety.length ? "complete" : "no_sections"));
    for (const [index, field] of requiredSafety.entries()) {
      const original = source.chunks.find(chunk => compact(chunk.text).includes(compact(field.quote)));
      const exactCitation = (item: GroundedResult["claims"][number] | GroundedResult["quiz"][number]) =>
        item.citations.some(c => c.chunkId === original?.id && compact(c.quote) === compact(field.quote));
      const section = coverage?.sections.find(section => {
        const claim = result.claims[section.claimIndex];
        return section.sourceSection === field.sourceSection && section.chunkId === original?.id &&
          !!claim && claim.category === "warning" && exactCitation(claim) &&
          compact(claim.text).includes(compact(field.body));
      });
      add("complete-safety-field:" + index + ":" + field.sourceSection, !!original && !!section);
      const questions = result.quiz.filter(question =>
        exactCitation(question) && question.learningObjective === "warning" &&
        question.sourceSection === field.sourceSection && question.coverageSectionId === section?.id &&
        question.assessmentScope === "one_key_point" && !!section?.quizIds.includes(question.id));
      add("specific-safety-quiz:" + index + ":" + field.sourceSection,
        !!section && questions.length > 0 && questions.every(question =>
          question.options.every(option => option.length <= 400)));
    }
  }
  return {
    passed: checks.every((check) => check.passed),
    checks,
    semanticReview: "pending_independent_review",
  };
}
