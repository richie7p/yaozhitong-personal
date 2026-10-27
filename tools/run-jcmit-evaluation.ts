/**
 * Isolated paper evaluation. Dry-run is the default. No application accounts,
 * databases, blob stores or cloud jobs are created or modified.
 *
 * A started case is never automatically replayed, even after a crash. Its outcome
 * may be unknown and the provider may already have billed it. Use a new run ID
 * only after reviewing that evidence, not to replace failed trials.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  GROUNDING_VERSION,
  Nvidia,
  grounded,
  recognize,
  RecognitionSchema,
  sourcePassages,
  type Llm,
} from "../server/ai.js";
import { aiRoutingIdentity, AppError, config } from "../server/config.js";
import { Catalog } from "../server/catalog.js";
import type { Store } from "../server/store.js";
import type { Chunk, Drug } from "../shared/schema.js";
import {
  scoreRecognition,
  summarizeRuns,
  type EvaluationRun,
} from "./evaluation-core.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const fileRef = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const referenceField = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("legible"),
      value: z.union([z.string(), z.number().finite()]),
      alternatives: z
        .array(z.union([z.string(), z.number().finite()]))
        .optional(),
    })
    .strict(),
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("illegible") }).strict(),
]);
const medicationReference = z
  .object({
    id,
    fields: z
      .object({
        name: referenceField,
        strength: referenceField,
        dose: referenceField,
        doseUnit: referenceField,
        frequency: referenceField,
        route: referenceField,
      })
      .strict(),
    expectedLicenseNo: z.string().nullable().optional(),
  })
  .strict();
const metadata = z.record(z.string(), z.unknown());
const visionCase = z
  .object({
    id,
    mode: z.literal("vision"),
    bagId: id,
    image: fileRef.extend({
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    }),
    medications: z.array(medicationReference).min(1).max(30),
    provenance: metadata.optional(),
    annotation: metadata.optional(),
  })
  .strict();
const learningCase = z
  .object({
    id,
    mode: z.literal("learning"),
    question: z.string().min(1).max(2000),
    source: fileRef,
    sourceGroupId: z.string().min(1).max(200).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    provenance: metadata.optional(),
    annotation: metadata.optional(),
  })
  .strict();
export const JcmitManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: id,
    split: z.enum(["development", "test"]),
    referenceStatus: z.enum(["ai_draft", "human_reviewed", "adjudicated"]),
    deidentified: z.literal(true),
    preparedAt: z.string().optional(),
    privacyScope: z.string().max(3000).optional(),
    catalog: fileRef.optional(),
    cases: z
      .array(z.discriminatedUnion("mode", [visionCase, learningCase]))
      .min(1)
      .max(1000),
  })
  .strict();
export type JcmitManifest = z.infer<typeof JcmitManifestSchema>;
type Case = JcmitManifest["cases"][number];
type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
};
export interface EvaluationOptions {
  manifest: string;
  mode: "vision" | "learning";
  runId: string;
  maxCases: number;
  repeats: number;
  maxRequests: number;
  maxEstimatedUsd: number;
  allowProvisional: boolean;
  runRealAi: boolean;
}
interface Dependencies {
  /** Tests inject a fake fetch; the CLI always uses the real transport. */
  transport?: typeof fetch;
  cwd?: string;
  log?: (entry: unknown) => void;
}
type RequestEvidence = {
  sequence: number;
  caseKey: string;
  startedAt: string;
  state: "started" | "completed" | "failed";
  estimatedUpperUsd: number;
  latencyMs?: number;
  status?: number;
  model?: string | null;
  serviceTier?: string | null;
  usage?: Usage;
  rawUsage?: unknown;
  response?: unknown;
  error?: string;
  reportedCostUpperUsd?: number | null;
};
type Trial = {
  runId: string;
  caseId: string;
  bagId: string;
  split: string;
  condition: string;
  repeatId: number;
  caseKey: string;
  referenceStatus: string;
  humanValidated: boolean;
  state: "started" | "completed" | "interrupted";
  status: "succeeded" | "failed" | "partial" | "refused";
  startedAt: string;
  finishedAt?: string;
  latencyMs: number | null;
  error?: string;
  requests: RequestEvidence[];
  [key: string]: unknown;
};
type State = {
  schemaVersion: 1;
  planHash: string;
  runId: string;
  createdAt: string;
  requests: RequestEvidence[];
  trials: Record<string, Trial>;
};
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
function guard(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AppError(code, code, 400);
}
function safeError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(code)
    ? code
    : "evaluation_failed";
}
function sanitize(value: unknown): any {
  if (typeof value === "string") {
    let text = value;
    for (const secret of [config.openaiKey, config.nvidiaKey])
      if (secret.length >= 8)
        text = text.split(secret).join("[credential redacted]");
    return text
      .replace(/\b(?:sk|nvapi)-[A-Za-z0-9_.*-]+/gi, "[credential redacted]")
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, "[image omitted]");
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitize(item)]),
    );
  return value;
}
async function atomicJson(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(sanitize(value), null, 2), {
    mode: 0o600,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(path + ".tmp", path);
      break;
    } catch (error: any) {
      // Windows virus/indexing scanners can briefly keep the destination open.
      // Never unlink the durable checkpoint as a rename workaround.
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 9
      )
        throw error;
      await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
    }
  }
}
function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
export function normalizedUsage(raw: any): Usage {
  return {
    inputTokens: finiteToken(raw?.prompt_tokens ?? raw?.input_tokens),
    outputTokens: finiteToken(raw?.completion_tokens ?? raw?.output_tokens),
    cachedInputTokens: finiteToken(
      raw?.prompt_tokens_details?.cached_tokens ??
        raw?.input_tokens_details?.cached_tokens,
    ),
    cacheWriteTokens: finiteToken(
      raw?.prompt_tokens_details?.cache_write_tokens ??
        raw?.input_tokens_details?.cache_write_tokens ??
        raw?.cache_creation_input_tokens ??
        raw?.cache_write_tokens,
    ),
  };
}
// Pinned 2026-10-20 Luna Standard rates. Use the greater long-context cache-write
// and output rates for all tokens, ignoring discounts, to bound reported usage.
// This is an estimate, not a provider-enforced dollar cap or an invoice.
export const COST_POLICY = {
  observedAt: "2026-10-20",
  source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
  inputUpperUsdPerMillion: 0.25,
  outputUpperUsdPerMillion: 0.75,
  imageInputTokenReservation: 32768,
  caveat:
    "Conservative planning estimate; unknown usage blocks further requests. Image reservation is an estimate, not a guaranteed billing ceiling.",
};
const costUpper = (input: number, output: number) =>
  (input * COST_POLICY.inputUpperUsdPerMillion +
    output * COST_POLICY.outputUpperUsdPerMillion) /
  1e6;
export function estimateRequest(body: any) {
  let images = 0;
  const withoutImages = JSON.stringify(body, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      images++;
      return "";
    }
    return value;
  });
  // UTF-8 bytes overestimate ordinary text tokenization; image tokens require a
  // separately declared reservation. Actual usage is checked after each call.
  const input =
    Buffer.byteLength(withoutImages) +
    images * COST_POLICY.imageInputTokenReservation;
  const output = Number(body.max_completion_tokens);
  guard(
    Number.isInteger(output) && output > 0,
    "evaluation_invalid_output_limit",
  );
  return {
    inputTokens: input,
    outputTokens: output,
    upperUsd: costUpper(input, output),
  };
}

export function parseOptions(args: string[]): EvaluationOptions {
  const flags = new Set(["--run-real-ai", "--allow-provisional"]);
  const values = new Set([
    "--manifest",
    "--mode",
    "--run-id",
    "--max-cases",
    "--repeats",
    "--max-requests",
    "--max-estimated-usd",
  ]);
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    guard(!(key in parsed), "evaluation_duplicate_argument");
    if (flags.has(key)) parsed[key] = true;
    else {
      guard(
        values.has(key) && !!args[i + 1] && !args[i + 1].startsWith("--"),
        "evaluation_invalid_argument",
      );
      parsed[key] = args[++i];
    }
  }
  const runRealAi = parsed["--run-real-ai"] === true;
  if (runRealAi)
    for (const key of [
      "--run-id",
      "--max-cases",
      "--repeats",
      "--max-requests",
      "--max-estimated-usd",
    ])
      guard(key in parsed, "evaluation_explicit_limits_required");
  const options = {
    manifest: String(parsed["--manifest"] || ""),
    mode: String(parsed["--mode"] || ""),
    runId: String(parsed["--run-id"] || "dry-run"),
    maxCases: Number(parsed["--max-cases"] || 1),
    repeats: Number(parsed["--repeats"] || 1),
    maxRequests: Number(parsed["--max-requests"] || 3),
    maxEstimatedUsd: Number(parsed["--max-estimated-usd"] || 0.1),
    runRealAi,
    allowProvisional: parsed["--allow-provisional"] === true,
  };
  validateOptions(options);
  return options as EvaluationOptions;
}
function validateOptions(
  o: Omit<EvaluationOptions, "mode"> & { mode: string },
) {
  guard(
    !!o.manifest && ["vision", "learning"].includes(o.mode),
    "evaluation_manifest_and_mode_required",
  );
  guard(id.safeParse(o.runId).success, "evaluation_invalid_run_id");
  for (const [n, cap] of [
    [o.maxCases, 1000],
    [o.repeats, 20],
    [o.maxRequests, 1000],
  ])
    guard(Number.isInteger(n) && n > 0 && n <= cap, "evaluation_invalid_limit");
  guard(
    Number.isFinite(o.maxEstimatedUsd) &&
      o.maxEstimatedUsd > 0 &&
      o.maxEstimatedUsd <= 20,
    "evaluation_invalid_budget",
  );
}
async function pinnedFile(base: string, ref: z.infer<typeof fileRef>) {
  const path = resolve(base, ref.path);
  const data = await readFile(path);
  guard(sha(data) === ref.sha256, "evaluation_file_hash_mismatch");
  return { path, data };
}
const chunkSchema = z
  .object({
    id: z.string().min(1),
    licenseNo: z.string().min(1),
    version: z.string().min(1),
    page: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    text: z.string().min(1),
    sourceFormat: z.enum(["pdf", "html"]).optional(),
  })
  .strict();
const drugSchema = z
  .object({
    licenseNo: z.string().min(1),
    nameZh: z.string(),
    nameEn: z.string(),
    strength: z.string(),
    form: z.string(),
    ingredients: z.array(z.string()),
    revoked: z.boolean(),
  })
  .passthrough();
async function codeFingerprint(cwd: string) {
  const files = [
    "server/ai.ts",
    "server/llm.ts",
    "server/catalog.ts",
    "server/config.ts",
    "server/source-boundary.ts",
    "server/safety-learning.ts",
    "server/recognition-usage.ts",
    "shared/learning.ts",
    "shared/source.ts",
    "shared/schema.ts",
    "package-lock.json",
    "tools/run-jcmit-evaluation.ts",
    "tools/evaluation-core.ts",
  ];
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        sha(await readFile(resolve(cwd, file))),
      ]),
    ),
  );
}
async function acquireRunLock(directory: string) {
  const path = join(directory, "run.lock");
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    guard(
      Number.isInteger(previous.pid) && previous.pid > 0,
      "evaluation_invalid_lock",
    );
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error: any) {
      if (error.code === "ESRCH") alive = false;
    }
    guard(!alive, "evaluation_run_locked");
    await unlink(path);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  return async () => {
    await handle.close();
    await unlink(path);
  };
}
function resolvedGeneration(raw: any, sources: any[]) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const resolveCitations = (items: any[]) =>
    (Array.isArray(items) ? items : []).map((item) => ({
      ...structuredClone(item),
      citations: (Array.isArray(item?.citations) ? item.citations : []).map(
        (citation: any) => {
          const source = byId.get(citation?.sourceId);
          if (
            citation &&
            typeof citation === "object" &&
            "sourceId" in citation
          ) {
            if (source && Object.keys(citation).length === 1)
              return {
                chunkId: source.chunkId,
                quote: source.quote ?? source.text,
              };
            return {
              ...structuredClone(citation),
              resolutionError: "invalid_source_reference",
            };
          }
          return structuredClone(citation);
        },
      ),
    }));
  return {
    status: raw?.status ?? null,
    claims: resolveCitations(raw?.claims),
    quiz: resolveCitations(raw?.quiz),
    label: "unverified_same_generation_candidates_not_independent_direct_arm",
    humanSupported: null,
  };
}
function learningSourceGroup(
  entry: z.infer<typeof learningCase>,
  chunks: Chunk[],
) {
  return (
    entry.sourceGroupId ||
    [...new Set(chunks.map((chunk) => chunk.licenseNo))].sort().join("|") ||
    "source-" + entry.source.sha256
  );
}

export async function runJcmitEvaluation(
  options: EvaluationOptions,
  dependencies: Dependencies = {},
) {
  validateOptions(options);
  const cwd = resolve(dependencies.cwd || process.cwd());
  const log =
    dependencies.log ||
    ((entry: unknown) => console.log(JSON.stringify(entry)));
  const manifestPath = resolve(cwd, options.manifest);
  const bytes = await readFile(manifestPath);
  const manifest = JcmitManifestSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  guard(
    new Set(manifest.cases.map((c) => c.id)).size === manifest.cases.length,
    "evaluation_duplicate_case_id",
  );
  guard(
    manifest.referenceStatus !== "ai_draft" ||
      options.allowProvisional ||
      !options.runRealAi,
    "evaluation_provisional_requires_opt_in",
  );
  const cases = manifest.cases
    .filter((c) => c.mode === options.mode)
    .slice(0, options.maxCases);
  guard(cases.length > 0, "evaluation_no_selected_cases");
  const inputs = new Map<string, Buffer>();
  const chunksById = new Map<string, Chunk[]>();
  for (const entry of cases) {
    if (entry.mode === "vision") {
      guard(
        new Set(entry.medications.map((m) => m.id)).size ===
          entry.medications.length,
        "evaluation_duplicate_medication_id",
      );
      // Exercise reference validation before even a dry run can claim readiness.
      scoreRecognition(
        {
          caseId: entry.id,
          bagId: entry.bagId,
          split: manifest.split,
          referenceStatus: manifest.referenceStatus,
          medications: entry.medications,
        },
        [],
      );
      const image = await pinnedFile(dirname(manifestPath), entry.image);
      guard(
        image.data.length > 0 && image.data.length <= 10 * 1024 * 1024,
        "evaluation_invalid_image_size",
      );
      const validImage =
        entry.image.mediaType === "image/png"
          ? image.data
              .subarray(0, 8)
              .equals(Buffer.from("89504e470d0a1a0a", "hex"))
          : entry.image.mediaType === "image/jpeg"
            ? image.data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
            : image.data.subarray(0, 4).toString() === "RIFF" &&
              image.data.subarray(8, 12).toString() === "WEBP";
      guard(validImage, "evaluation_image_signature_mismatch");
      inputs.set(entry.id, image.data);
    } else {
      const source = await pinnedFile(dirname(manifestPath), entry.source);
      const parsed = z
        .object({
          chunks: z.array(chunkSchema).max(200),
          provenance: metadata.optional(),
        })
        .strict()
        .parse(JSON.parse(source.data.toString("utf8")));
      guard(
        new Set(parsed.chunks.map((c) => c.id)).size === parsed.chunks.length,
        "evaluation_duplicate_chunk_id",
      );
      chunksById.set(entry.id, parsed.chunks);
    }
  }
  let catalogRows: Drug[] = [];
  if (options.mode === "vision") {
    guard(manifest.catalog, "evaluation_catalog_required");
    const catalogFile = await pinnedFile(
      dirname(manifestPath),
      manifest.catalog,
    );
    catalogRows = z
      .array(drugSchema)
      .min(1)
      .parse(JSON.parse(catalogFile.data.toString("utf8")));
  }
  const safeConfig = {
    provider: config.aiProvider,
    textModel: config.textModel,
    visionModel: config.visionModel,
    routing: aiRoutingIdentity(),
    visionMaxTokens: config.aiVisionMaxTokens,
    groundingVersion: GROUNDING_VERSION,
    reasoningEffort: "none",
    serviceTier: "provider_default",
  };
  const plan = {
    schemaVersion: 1,
    runId: options.runId,
    mode: options.mode,
    datasetId: manifest.datasetId,
    datasetHash: sha(bytes),
    preparedAt: manifest.preparedAt ?? null,
    privacyScope: manifest.privacyScope ?? null,
    referenceStatus: manifest.referenceStatus,
    humanValidated: manifest.referenceStatus !== "ai_draft",
    config: safeConfig,
    configHash: sha(canonical(safeConfig)),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    sourceCode: await codeFingerprint(cwd),
    limits: {
      maxCases: options.maxCases,
      repeats: options.repeats,
      maxRequests: options.maxRequests,
      maxEstimatedUsd: options.maxEstimatedUsd,
    },
    costPolicy: COST_POLICY,
    cases: cases.map((c) => ({
      id: c.id,
      inputHash: c.mode === "vision" ? c.image.sha256 : c.source.sha256,
      expectedReferenceHash: sha(canonical(c)),
      provenance: c.provenance ?? null,
      annotation: c.annotation ?? null,
      sourceGroupId:
        c.mode === "learning"
          ? learningSourceGroup(c, chunksById.get(c.id)!)
          : null,
    })),
    catalogHash: manifest.catalog?.sha256 ?? null,
    selectedCaseCount: cases.length,
    trialCount: cases.length * options.repeats,
    maximumProductionRequestsBeforeBudgetGuard:
      cases.length * options.repeats * (options.mode === "vision" ? 3 : 6),
    defaultDryRun: !options.runRealAi,
  };
  if (!options.runRealAi) {
    log({
      status: "dry_run",
      ...plan,
      warning:
        manifest.referenceStatus === "ai_draft"
          ? "Provisional AI annotations are not human-reviewed gold data."
          : null,
    });
    return { status: "dry_run", plan, trials: [] };
  }
  guard(
    config.aiProvider === "openai" &&
      config.textModel === "gpt-6-luna" &&
      config.visionModel === "gpt-6-luna" &&
      config.openaiBase.replace(/\/$/, "") === "https://api.openai.com/v1",
    "evaluation_pricing_configuration_mismatch",
  );
  guard(!!config.openaiKey, "evaluation_ai_not_configured");
  // Keep this tool's writes below one private directory even when a parent is a
  // symlink. Nothing is written beside source images, sources or application data.
  const parent = resolve(cwd, ".local/jcmit-evaluation");
  await mkdir(parent, { recursive: true });
  const resolvedParent = await realpath(parent),
    resolvedCwd = await realpath(cwd);
  const parentRelative = relative(resolvedCwd, resolvedParent);
  guard(
    !isAbsolute(parentRelative) && !parentRelative.startsWith(".."),
    "evaluation_output_outside_workspace",
  );
  const directory = join(resolvedParent, options.runId);
  await mkdir(directory, { recursive: true });
  guard(
    (await realpath(directory)) === directory,
    "evaluation_run_directory_symlink",
  );
  const release = await acquireRunLock(directory);
  const statePath = join(directory, "state.json");
  const planHash = sha(canonical(plan));
  let state: State;
  const originalFetch = globalThis.fetch;
  const transport = dependencies.transport || originalFetch;
  let active: Trial | undefined;
  try {
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      state = {
        schemaVersion: 1,
        planHash,
        runId: options.runId,
        createdAt: new Date().toISOString(),
        requests: [],
        trials: {},
      };
    }
    guard(
      state.planHash === planHash && state.runId === options.runId,
      "evaluation_resume_plan_mismatch",
    );
    for (const trial of Object.values(state.trials)) {
      if (trial.state === "started") {
        trial.state = "interrupted";
        trial.status = "failed";
        trial.error = "interrupted_outcome_unknown_not_replayed";
      }
    }
    const save = () => atomicJson(statePath, state);
    await atomicJson(join(directory, "plan.json"), plan);
    await save();
    const unknownUsage = () =>
      state.requests.some(
        (r) =>
          r.state !== "completed" ||
          r.usage?.inputTokens == null ||
          r.usage?.outputTokens == null,
      );
    const spentUpper = () =>
      state.requests.reduce(
        (sum, r) => sum + (r.reportedCostUpperUsd ?? r.estimatedUpperUsd),
        0,
      );
    globalThis.fetch = async (input, init) => {
      guard(active, "evaluation_unscoped_request");
      const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url;
      guard(
        url === "https://api.openai.com/v1/chat/completions" &&
          init?.method === "POST",
        "evaluation_external_request_blocked",
      );
      guard(!unknownUsage(), "evaluation_unknown_usage_stop");
      guard(
        state.requests.length < options.maxRequests,
        "evaluation_request_cap",
      );
      const body = JSON.parse(String(init.body));
      guard(body.model === "gpt-6-luna", "evaluation_unpriced_model");
      const estimate = estimateRequest(body);
      guard(
        spentUpper() + estimate.upperUsd <= options.maxEstimatedUsd,
        "evaluation_estimated_budget_cap",
      );
      const request: RequestEvidence = {
        sequence: state.requests.length + 1,
        caseKey: active.caseKey,
        startedAt: new Date().toISOString(),
        state: "started",
        estimatedUpperUsd: estimate.upperUsd,
      };
      state.requests.push(request);
      active.requests.push(request);
      // Durable intent precedes transport: a lost response cannot silently cause
      // the same case to be billed again when this process is restarted.
      await save();
      const started = Date.now();
      try {
        const response = await transport(input, init);
        request.status = response.status;
        // Evaluation intentionally awaits body capture; the same response bytes
        // are then consumed by the production client. No duplicate model call.
        const responseText = await response.text();
        let parsed: any = null;
        try {
          parsed = JSON.parse(responseText);
        } catch {
          /* retained as format failure */
        }
        request.response = parsed ? sanitize(parsed) : { unreadableJson: true };
        request.rawUsage = parsed?.usage ?? null;
        request.usage = normalizedUsage(parsed?.usage);
        request.model = typeof parsed?.model === "string" ? parsed.model : null;
        request.serviceTier =
          typeof parsed?.service_tier === "string" ? parsed.service_tier : null;
        const { inputTokens, outputTokens } = request.usage;
        request.reportedCostUpperUsd =
          inputTokens != null && outputTokens != null
            ? costUpper(inputTokens, outputTokens)
            : null;
        request.state = "completed";
        return new Response(responseText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        request.state = "failed";
        request.error = safeError(error);
        throw error;
      } finally {
        request.latencyMs = Date.now() - started;
        await save();
      }
    };
    // Use the production candidate ranker over a pinned, read-only catalog.
    const catalog = new Catalog({} as Store);
    catalog.all = async () => catalogRows;
    const predictionsFor = (
      medications: z.infer<typeof RecognitionSchema>["medications"],
    ) =>
      Promise.all(
        medications.map(async (medication) => ({
          fields: {
            name: medication.name,
            strength: medication.strength,
            dose: medication.doseText || medication.doseAmount,
            doseUnit: medication.doseUnit,
            frequency: medication.frequencyRaw,
            route: medication.route,
          },
          candidates: await catalog
            .search(
              medication.name,
              medication.strength || "",
              medication.form || "",
            )
            .then((rows) => rows.map((drug) => drug.licenseNo)),
        })),
      );
    for (const entry of cases)
      for (let repeatId = 1; repeatId <= options.repeats; repeatId++) {
        const caseKey = sha(
          canonical({ planHash, caseId: entry.id, repeatId }),
        );
        if (state.trials[caseKey]) continue;
        const trial: Trial = {
          runId: options.runId,
          caseId: entry.id,
          bagId:
            entry.mode === "vision"
              ? entry.bagId
              : learningSourceGroup(entry, chunksById.get(entry.id)!),
          split: manifest.split,
          condition:
            options.mode === "vision"
              ? "production_recognize"
              : "production_grounded",
          repeatId,
          caseKey,
          referenceStatus: manifest.referenceStatus,
          humanValidated: manifest.referenceStatus !== "ai_draft",
          state: "started",
          status: "failed",
          startedAt: new Date().toISOString(),
          latencyMs: null,
          requests: [],
          inputHash:
            entry.mode === "vision" ? entry.image.sha256 : entry.source.sha256,
          configHash: plan.configHash,
          sourceGroupId:
            entry.mode === "learning"
              ? learningSourceGroup(entry, chunksById.get(entry.id)!)
              : null,
          annotation: entry.annotation ?? null,
          provenance: entry.provenance ?? null,
        };
        const reference =
          entry.mode === "vision"
            ? {
                caseId: entry.id,
                bagId: entry.bagId,
                split: manifest.split,
                referenceStatus: manifest.referenceStatus,
                medications: entry.medications,
              }
            : undefined;
        // A timeout or invalid output remains in every applicable field denominator,
        // not just the whole-bag success denominator.
        if (reference) {
          trial.reference = reference;
          trial.predictions = [];
          trial.recognition = scoreRecognition(reference, []);
        }
        state.trials[caseKey] = trial;
        active = trial;
        await save();
        const started = Date.now();
        const client = new Nvidia();
        const traced: Llm = {
          json: async (system, content, vision) => {
            const result = await client.json(system, content, vision);
            if (vision) trial.rawRecognition = structuredClone(result);
            else if (!(content as any)?.expectedIds) {
              trial.rawGeneration = structuredClone(result);
              trial.generationSources = structuredClone(
                (content as any)?.sources || [],
              );
              trial.candidate = resolvedGeneration(
                result,
                entry.mode === "learning"
                  ? sourcePassages(chunksById.get(entry.id)!)
                  : (content as any)?.sources || [],
              );
            } else trial.verificationResponse = structuredClone(result);
            await save();
            return result;
          },
        };
        try {
          guard(!unknownUsage(), "evaluation_unknown_usage_stop");
          guard(
            state.requests.length < options.maxRequests,
            "evaluation_request_cap",
          );
          guard(
            spentUpper() < options.maxEstimatedUsd,
            "evaluation_estimated_budget_cap",
          );
          if (entry.mode === "vision") {
            const result = await recognize(
              traced,
              inputs.get(entry.id)!,
              entry.image.mediaType,
            );
            const predictions = await predictionsFor(result.medications);
            trial.recognitionResult = result;
            trial.predictions = predictions;
            trial.recognition = scoreRecognition(reference!, predictions);
            trial.status =
              result.status === "succeeded" ? "succeeded" : "failed";
          } else {
            const chunks = chunksById.get(entry.id)!;
            trial.sourceChunks = chunks;
            const result = await grounded(
              traced,
              entry.question,
              chunks,
              entry.context || {},
              "bundle",
            );
            trial.published = result;
            const hasPurpose = result.claims.some(
              (claim) => claim.category === "purpose",
            );
            const hasQuiz = result.quiz.length > 0;
            const safetyFieldsComplete = ["complete", "no_sections"].includes(
              result.safetyCoverage?.status || "",
            );
            const workflowComplete =
              result.status === "supported" &&
              hasPurpose &&
              hasQuiz &&
              safetyFieldsComplete;
            trial.modelStatus = result.status;
            trial.workflowCompletion = {
              hasPurpose,
              hasQuiz,
              safetyFieldsComplete,
              complete: workflowComplete,
              scope:
                "Structural coverage only; not human semantic review or learner comprehension.",
            };
            trial.status = workflowComplete
              ? "succeeded"
              : result.status === "refused"
                ? "refused"
                : "partial";
            trial.semanticReview = {
              status: "not_human_reviewed",
              candidateSupported: null,
              publishedSupported: null,
              quizUniqueAndSupported: null,
            };
          }
        } catch (error) {
          trial.error = safeError(error);
        } finally {
          if (reference) {
            const raw = trial.rawRecognition;
            const parsed = RecognitionSchema.safeParse(
              Array.isArray(raw) && raw.length === 1 ? raw[0] : raw,
            );
            trial.rawRecognitionScorable = parsed.success;
            if (parsed.success) {
              const rawPredictions = await predictionsFor(
                parsed.data.medications,
              );
              trial.rawPredictions = rawPredictions;
              trial.rawRecognitionScore = scoreRecognition(
                reference,
                rawPredictions,
              );
            }
          }
          trial.state = "completed";
          trial.finishedAt = new Date().toISOString();
          trial.latencyMs = Date.now() - started;
          trial.providerRequestsAttempted = trial.requests.length;
          trial.productionRequests = client.requests;
          await save();
          await atomicJson(
            join(directory, `${entry.id}-repeat-${repeatId}.json`),
            trial,
          );
          log({
            runId: options.runId,
            caseId: entry.id,
            repeatId,
            status: trial.status,
            error: trial.error ?? null,
            requests: trial.requests.length,
          });
          active = undefined;
        }
      }
    const evaluationRuns: EvaluationRun[] = Object.values(state.trials).map(
      (trial) => ({
      runId: trial.caseKey,
        caseId: trial.caseId,
        bagId: trial.bagId,
        split: manifest.split,
        condition: trial.condition,
        repeatId: trial.repeatId,
        referenceStatus: manifest.referenceStatus,
        status: trial.status,
        latencyMs: trial.latencyMs,
        requests: trial.requests.map(
          (request) => request.usage ?? normalizedUsage(null),
        ),
        ...(trial.recognition
          ? { recognition: trial.recognition as EvaluationRun["recognition"] }
          : {}),
      }),
    );
    await atomicJson(join(directory, "evaluation-runs.json"), evaluationRuns);
    const summary = {
      status: "completed",
      runId: options.runId,
      manifestHash: plan.datasetHash,
      referenceStatus: manifest.referenceStatus,
      humanValidated: manifest.referenceStatus !== "ai_draft",
      plannedTrials: plan.trialCount,
      recordedTrials: Object.keys(state.trials).length,
      requestCount: state.requests.length,
      unknownUsage: unknownUsage(),
      estimatedReportedCostUpperUsd: unknownUsage() ? null : spentUpper(),
      failedTrials: Object.values(state.trials).filter(
        (t) => t.status === "failed",
      ).length,
      interruptedTrials: Object.values(state.trials).filter(
        (t) => t.state === "interrupted",
      ).length,
      metrics: summarizeRuns(evaluationRuns),
      note: "Runner completion is not scientific acceptance. Draft references are not human gold labels. Failures and incomplete outputs remain in the denominator.",
    };
    await atomicJson(join(directory, "summary.json"), summary);
    log(summary);
    return {
      status: "completed",
      plan,
      trials: Object.values(state.trials),
      summary,
    };
  } finally {
    globalThis.fetch = originalFetch;
    await release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await runJcmitEvaluation(
      parseOptions(process.argv.slice(2)),
    );
    if (
      result.status === "completed" &&
      result.trials.some((t) => t.status !== "succeeded")
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({ status: "blocked", code: safeError(error) }),
    );
    process.exitCode = 1;
  }
}
