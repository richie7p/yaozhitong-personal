/** Bounded opt-in review replay. Does not change production configuration. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../server/config.js";

type Effort = "none" | "low";
type Fixture = {
  id: string;
  system: string;
  input: any;
  expected: { id: string; supported: boolean; reason: string }[];
};
const sourceDirectory = resolve(".local/seminar-flow-1792454113916-377e9e87");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeCode = (value: unknown) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.-]{1,100}$/.test(value) &&
  !/^(?:sk-|nvapi-)/i.test(value)
    ? value
    : null;
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
function usageOf(usage: any) {
  return {
    inputTokens: finite(usage?.prompt_tokens ?? usage?.input_tokens),
    outputTokens: finite(usage?.completion_tokens ?? usage?.output_tokens),
    reasoningTokens: finite(
      usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens,
    ),
    cachedInputTokens: finite(
      usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens,
    ),
    cacheWriteTokens: finite(
      usage?.cache_write_tokens ?? usage?.cache_creation_input_tokens,
    ),
    totalTokens: finite(usage?.total_tokens),
  };
}

async function fixtures(): Promise<Fixture[]> {
  const load = async (file: string) => {
    const saved = JSON.parse(
      await readFile(join(sourceDirectory, file), "utf8"),
    );
    const system = saved.request?.messages?.[0]?.content;
    const raw = saved.request?.messages?.[1]?.content;
    assert.equal(typeof system, "string");
    assert.equal(typeof raw, "string");
    assert.ok(system.includes("保守的證據審核器") && /JSON/i.test(system));
    assert.ok(!raw.includes("data:image/") && !raw.includes("image_url"));
    const input = JSON.parse(raw);
    // Historical acceptance traces used a synthetic profile; replace it again
    // so this diagnostic cannot copy patient details added to an old trace.
    input.context.profile = {
      age: 32,
      sex: "unspecified",
      conditions: ["氣喘"],
      allergies: "",
      pregnancy: "unknown",
      notes: "Synthetic software-test profile; no real patient data.",
    };
    return { system, input };
  };
  const enzyme = await load("upstream-03.json");
  const cough = await load("upstream-05.json");
  const conditioned = cough.input.claims.find(
    (claim: any) =>
      claim.checkType === "content" &&
      claim.parentConditions?.includes("所引起之咳嗽"),
  );
  const purpose = enzyme.input.claims.find(
    (claim: any) => claim.checkType === "content",
  );
  const uniqueQuiz = enzyme.input.claims.find(
    (claim: any) => claim.checkType === "quiz",
  );
  const coughQuiz = cough.input.claims.find(
    (claim: any) =>
      claim.checkType === "quiz" && claim.sourceSection === "適應症",
  );
  assert.ok(conditioned && purpose && uniqueQuiz && coughQuiz);
  const make = (
    id: string,
    source: typeof enzyme,
    checks: any[],
    expected: [boolean, string][],
  ): Fixture => {
    const input = structuredClone(source.input);
    input.claims = checks.map((claim, index) => ({
      ...structuredClone(claim),
      id: `claim-${index}`,
    }));
    input.expectedIds = input.claims.map((claim: any) => claim.id);
    return {
      id,
      system: source.system,
      input,
      expected: expected.map(([supported, reason], index) => ({
        id: `claim-${index}`,
        supported,
        reason,
      })),
    };
  };
  return [
    make(
      "inherited-condition",
      cough,
      [
        conditioned,
        { ...conditioned, text: "所有氣喘病人都請勿自行使用本藥。" },
      ],
      [
        [true, "The actual claim preserves the cited causal cough condition."],
        [
          false,
          "Asthma alone broadens the cited condition to all asthma patients.",
        ],
      ],
    ),
    make(
      "unsupported-advice",
      enzyme,
      [
        purpose,
        { ...purpose, text: "本藥對所有人都安全，而且沒有任何藥物交互作用。" },
      ],
      [
        [true, "The purpose statement is directly supported by its own quote."],
        [
          false,
          "An indication quote cannot establish universal safety or no interactions.",
        ],
      ],
    ),
    make(
      "quiz-unique-answer",
      enzyme,
      [
        uniqueQuiz,
        {
          ...coughQuiz,
          options: ["袪痰", "袪痰"],
          answer: 0,
        },
      ],
      [
        [
          true,
          "The original purpose quiz has one answer supported by its named section.",
        ],
        [
          false,
          "Both options are identical supported answers, so uniqueness fails.",
        ],
      ],
    ),
  ];
}

function requestBody(fixture: Fixture, effort: Effort) {
  return {
    model: "gpt-6-luna",
    store: false,
    reasoning_effort: effort,
    max_completion_tokens: 6000,
    ...(effort === "none" ? { temperature: 0.1 } : {}),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: fixture.system },
      { role: "user", content: JSON.stringify(fixture.input) },
    ],
  };
}

async function review(
  fixture: Fixture,
  effort: Effort,
  key: string,
  send: typeof fetch = fetch,
  timeoutMs = 45000,
) {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const result: any = {
    fixture: fixture.id,
    effort,
    inputSha256: hash({ system: fixture.system, input: fixture.input }),
    status: "failed",
    httpRequests: 1,
    httpStatus: null,
    actualModel: null,
    usage: usageOf(null),
    verdicts: [],
    expected: fixture.expected,
  };
  try {
    const response = await send("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody(fixture, effort)),
      signal,
    });
    result.httpStatus = response.status;
    const body: any = await response.json();
    result.actualModel = safeCode(body?.model);
    result.usage = usageOf(body?.usage);
    if (!response.ok) {
      result.error = "provider_http_error";
      result.providerErrorCode = String(body?.error?.code || "").includes(key)
        ? null
        : safeCode(body?.error?.code);
      result.providerErrorParameter = String(body?.error?.param || "").includes(
        key,
      )
        ? null
        : safeCode(body?.error?.param);
      return result;
    }
    const choice = body?.choices?.[0];
    result.finishReason = safeCode(choice?.finish_reason);
    if (result.actualModel !== "gpt-6-luna") {
      result.error = "unexpected_response_model";
      return result;
    }
    if (choice?.finish_reason !== "stop" || choice?.message?.refusal) {
      result.error =
        choice?.finish_reason === "length"
          ? "output_limit"
          : "refused_or_incomplete";
      return result;
    }
    const parsed = JSON.parse(String(choice?.message?.content ?? ""));
    const verdicts = parsed?.verdicts;
    const ids = fixture.expected.map((item) => item.id);
    if (
      !Array.isArray(verdicts) ||
      verdicts.length !== ids.length ||
      new Set(verdicts.map((item) => item?.id)).size !== ids.length ||
      verdicts.some(
        (item) =>
          !ids.includes(item?.id) || typeof item?.supported !== "boolean",
      )
    ) {
      result.error = "invalid_verdict_shape";
      return result;
    }
    result.verdicts = ids.map((id) => ({
      id,
      supported: verdicts.find((item) => item.id === id).supported,
    }));
    result.correctJudgments = fixture.expected.filter((item) =>
      result.verdicts.some(
        (verdict: any) =>
          verdict.id === item.id && verdict.supported === item.supported,
      ),
    ).length;
    result.allCorrect = result.correctJudgments === fixture.expected.length;
    result.status = "succeeded";
    return result;
  } catch (error) {
    result.error = signal.aborted
      ? "timeout"
      : error instanceof SyntaxError
        ? "invalid_json"
        : "network_or_response_error";
    return result;
  } finally {
    result.latencyMs = Date.now() - started;
  }
}

function summarize(results: any[]) {
  return Object.fromEntries(
    (["none", "low"] as const).map((effort) => {
      const rows = results.filter((result) => result.effort === effort);
      const latencies = rows
        .map((result) => result.latencyMs)
        .sort((a, b) => a - b);
      const expectedJudgments = rows.reduce(
        (n, row) => n + row.expected.length,
        0,
      );
      const correctJudgments = rows.reduce(
        (n, row) => n + (row.correctJudgments || 0),
        0,
      );
      return [
        effort,
        {
          attempted: rows.length,
          succeeded: rows.filter((row) => row.status === "succeeded").length,
          failed: rows.filter((row) => row.status !== "succeeded").length,
          allCorrectCases: rows.filter((row) => row.allCorrect).length,
          expectedJudgments,
          correctJudgments,
          accuracyIncludingFailures: expectedJudgments
            ? correctJudgments / expectedJudgments
            : null,
          medianLatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
          maximumLatencyMs: latencies.at(-1) ?? null,
          totalLatencyMs: rows.reduce((n, row) => n + row.latencyMs, 0),
          usage: Object.fromEntries(
            Object.keys(usageOf(null)).map((key) => [
              key,
              {
                knownTotal: rows.reduce(
                  (n, row) => n + (row.usage[key] ?? 0),
                  0,
                ),
                missingResponses: rows.filter((row) => row.usage[key] === null)
                  .length,
              },
            ]),
          ),
        },
      ];
    }),
  );
}

async function selfTest(cases: Fixture[]) {
  let checks = 0;
  const captured: any[] = [];
  const fakeKey = "synthetic-reasoning-test-key";
  const complete = (fixture: Fixture, overrides: any = {}) =>
    Response.json({
      model: "gpt-6-luna",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              verdicts: fixture.expected.map(({ id, supported }) => ({
                id,
                supported,
              })),
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 20,
        total_tokens: 70,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      ...overrides,
    });
  const results: any[] = [];
  for (const fixture of cases)
    for (const effort of ["none", "low"] as const) {
      const fake: typeof fetch = async (url, init) => {
        assert.equal(url, "https://api.openai.com/v1/chat/completions");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${fakeKey}`,
        );
        assert.ok(init?.signal);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_completion_tokens, 6000);
        assert.equal(body.store, false);
        assert.equal(body.model, "gpt-6-luna");
        assert.equal(body.reasoning_effort, effort);
        assert.equal(body.response_format.type, "json_object");
        assert.ok(/JSON/i.test(body.messages[0].content));
        if (effort === "low") assert.ok(!("temperature" in body));
        else assert.equal(body.temperature, 0.1);
        captured.push(body);
        return complete(fixture);
      };
      const result = await review(fixture, effort, fakeKey, fake);
      assert.equal(result.status, "succeeded");
      assert.equal(result.allCorrect, true);
      assert.equal(result.usage.cacheWriteTokens, null);
      assert.equal(result.usage.reasoningTokens, 0);
      results.push(result);
      checks++;
    }
  for (let i = 0; i < captured.length; i += 2)
    assert.deepEqual(captured[i].messages, captured[i + 1].messages);
  checks++;
  const one = cases[0];
  const badShape = await review(one, "low", fakeKey, async () =>
    complete(one, {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content:
              '{"verdicts":[{"id":"claim-0","supported":true},{"id":"claim-0","supported":false}]}',
          },
        },
      ],
    }),
  );
  assert.equal(badShape.error, "invalid_verdict_shape");
  checks++;
  const truncated = await review(one, "low", fakeKey, async () =>
    complete(one, {
      choices: [{ finish_reason: "length", message: { content: "{}" } }],
    }),
  );
  assert.equal(truncated.error, "output_limit");
  checks++;
  const wrongModel = await review(one, "low", fakeKey, async () =>
    complete(one, { model: "other-model" }),
  );
  assert.equal(wrongModel.error, "unexpected_response_model");
  checks++;
  let failedCalls = 0;
  const httpFailure = await review(one, "none", fakeKey, async () => {
    failedCalls++;
    return Response.json(
      { error: { message: fakeKey, code: "busy", param: fakeKey } },
      { status: 500 },
    );
  });
  assert.equal(httpFailure.error, "provider_http_error");
  assert.equal(failedCalls, 1);
  assert.ok(!JSON.stringify(httpFailure).includes(fakeKey));
  checks++;
  const networkFailure = await review(one, "none", fakeKey, async () => {
    throw Error(fakeKey);
  });
  assert.equal(networkFailure.error, "network_or_response_error");
  assert.ok(!JSON.stringify(networkFailure).includes(fakeKey));
  checks++;
  const timeout = await review(
    one,
    "low",
    fakeKey,
    async (_url, init) => {
      await new Promise((_, reject) => {
        const hold = setTimeout(() => reject(Error("mock_abort_missing")), 100);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(hold);
            reject(Error(fakeKey));
          },
          { once: true },
        );
      });
      return complete(one);
    },
    5,
  );
  assert.equal(timeout.error, "timeout");
  checks++;
  const summary = summarize([
    ...results.filter((row) => row.fixture !== one.id),
    httpFailure,
    timeout,
  ]);
  assert.equal(summary.none.attempted, 3);
  assert.equal(summary.none.expectedJudgments, 6);
  assert.equal(summary.none.accuracyIncludingFailures, 4 / 6);
  assert.equal(summary.low.failed, 1);
  checks++;
  return {
    status: "passed",
    checks,
    externalHttpRequests: 0,
    fixtureCount: cases.length,
  };
}

async function main() {
  const cases = await fixtures();
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(await selfTest(cases), null, 2));
    return;
  }
  const real = process.argv.includes("--run-real-ai");
  if (
    real &&
    (config.aiProvider !== "openai" ||
      !config.openaiKey ||
      config.textModel !== "gpt-6-luna" ||
      config.openaiBase.replace(/\/$/, "") !== "https://api.openai.com/v1")
  )
    throw Error("openai_luna_configuration_required");
  const directory = resolve(
    `.local/seminar-reasoning-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true });
  const report: any = {
    startedAt: new Date().toISOString(),
    directory,
    scope:
      "fixed synthetic-profile text-only review replay; no photo or patient data",
    status: real ? "running" : "prepared_no_external_calls",
    provider: "openai",
    requestedModel: "gpt-6-luna",
    timeoutMs: 45000,
    retries: 0,
    maximumHttpRequests: 6,
    maximumCompletionTokensPerRequest: 6000,
    sourceDirectory,
    sourceFiles: ["upstream-03.json", "upstream-05.json"],
    fixtureSetSha256: hash(cases),
    fixtures: cases,
    parameterDifferences: {
      none: { reasoning_effort: "none", temperature: 0.1 },
      low: { reasoning_effort: "low", temperature: "omitted" },
    },
    limitations: [
      "Only three fixed cases; not an estimate of clinical accuracy or timeout reliability.",
      "All failures stay in the denominator; no replacement or automatic retry.",
      "Low omits temperature because that reasoning mode does not support it; this is not a perfectly isolated parameter comparison.",
      "The same 6000 completion-token cap is used for both modes; production review currently has a smaller cap.",
      "Reasoning tokens are included in output tokens; do not add them to output again.",
      "Missing usage fields remain unknown, not zero. No production settings changed.",
    ],
    results: [],
  };
  const save = async () => {
    report.summary = summarize(report.results);
    await writeFile(
      join(directory, "report.json"),
      JSON.stringify(report, null, 2),
    );
  };
  await save();
  if (real) {
    for (let index = 0; index < cases.length; index++) {
      const order: Effort[] = index % 2 ? ["low", "none"] : ["none", "low"];
      for (const effort of order) {
        report.results.push(
          await review(cases[index], effort, config.openaiKey),
        );
        await save();
        console.log(
          JSON.stringify({
            completed: report.results.length,
            total: 6,
            fixture: cases[index].id,
            effort,
            status: report.results.at(-1).status,
            latencyMs: report.results.at(-1).latencyMs,
          }),
        );
      }
    }
    report.status = "completed_all_attempts_preserved";
  }
  report.finishedAt = new Date().toISOString();
  report.httpRequests = report.results.length;
  await save();
  await mkdir(".local/reports", { recursive: true });
  await writeFile(
    ".local/reports/seminar-reasoning.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        directory,
        httpRequests: report.httpRequests,
        summary: report.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: "reasoning_comparison_failed_locally",
      code: safeCode(error?.code),
      location:
        String(error?.stack || "").match(
          /compare-seminar-reasoning\.ts:\d+:\d+/,
        )?.[0] || null,
    }),
  );
  process.exitCode = 1;
});
