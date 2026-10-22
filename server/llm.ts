import type { Llm } from "./ai.js";
import type { AiRequestMetric } from "../shared/schema.js";
import {
  aiConnection,
  aiModelRoute,
  AppError,
  config,
  fail,
} from "./config.js";
export type { AiRequestMetric } from "../shared/schema.js";

/** All model attempts and both stages share fixed request and job deadlines. */
export class JsonLlm implements Llm {
  tokens = 0;
  readonly requests: AiRequestMetric[] = [];
  private startedAt = Date.now();
  private unavailableModels = new Set<string>();

  async json(
    system: string,
    content: unknown,
    vision = false,
  ): Promise<unknown> {
    const connection = aiConnection();
    if (!connection.key)
      return fail(
        "ai_not_configured",
        "尚未設定 " + connection.label + " API 金鑰，可先手動建立藥品。",
        503,
      );
    // OpenAI JSON mode requires an explicit JSON instruction, including the
    // evidence-review stage whose original prompt may only show an object.
    const systemInstruction =
      config.aiProvider === "openai" && !/json/i.test(system)
        ? system + "\nReturn only a JSON object."
        : system;
    const configuredModels = aiModelRoute(vision);
    const availableModels = configuredModels.filter(
      (model) => !this.unavailableModels.has(model),
    );
    // After a successful switch, review uses the available model instead of
    // spending a second timeout on the same failed primary in this job.
    const models = availableModels.length ? availableModels : configuredModels;
    const expectedIds = (content as { expectedIds?: unknown[] })?.expectedIds;
    const verifying = Array.isArray(expectedIds);
    const primary = configuredModels[0];
    const reasoningEffort =
      config.aiProvider === "openai" &&
      (primary === "gpt-6-luna" || /^gpt-5\.[24](?:-|$)/.test(primary))
        ? vision
          ? "none"
          : config.aiTextReasoningEffort
        : undefined;
    const reasoningEnabled = !!reasoningEffort && reasoningEffort !== "none";
    const maxTokens = vision
      ? config.aiVisionMaxTokens
      : verifying && !reasoningEnabled
        ? Math.min(1600, Math.max(256, 100 + expectedIds.length * 45))
        : config.aiTextMaxTokens;
    const jobDeadline = this.startedAt + config.aiJobTimeoutMs;
    // Reserve time for the mandatory review, rather than spending the job on generation.
    const reserve =
      models.length > 1 && !vision && !verifying
        ? Math.min(15000, Math.floor(config.aiJobTimeoutMs / 3))
        : 0;
    const deadline = Math.min(
      jobDeadline - reserve,
      Date.now() +
        (vision
          ? config.aiRequestTimeoutMs
          : (config.aiTextRequestTimeoutMs ?? config.aiRequestTimeoutMs)),
    );
    const timeout = () =>
      new AppError("ai_timeout", "AI 回應逾時，輸入已保留，請稍後重試。", 503);
    let modelIndex = 0;
    let fallbackFrom: string | undefined;
    // A fallback consumes an attempt; it never multiplies the three-request cap.
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeout();
      const model = models[modelIndex];
      const hasFallback = modelIndex < models.length - 1;
      const attemptBudget = hasFallback
        ? Math.max(
            1,
            Math.min(
              config.aiPrimaryTimeoutMs,
              vision
                ? config.aiPrimaryTimeoutMs
                : config.aiTextPrimaryTimeoutMs,
              Math.floor(remaining / 2),
            ),
          )
        : remaining;
      const metric: AiRequestMetric = {
        provider: config.aiProvider,
        model,
        stage: vision ? "vision" : verifying ? "verification" : "generation",
        attempt: attempt + 1,
        latencyMs: 0,
        tokens: null,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fallbackFrom ? { fallbackFrom } : {}),
      };
      this.requests.push(metric);
      const started = Date.now();
      const attemptSignal = AbortSignal.timeout(attemptBudget);
      let error: AppError | undefined;
      let retryAfterMs = 0;
      try {
        const response = await fetch(
          connection.base.replace(/\/$/, "") + "/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + connection.key,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: systemInstruction },
                {
                  role: "user",
                  content:
                    typeof content === "string" || Array.isArray(content)
                      ? content
                      : JSON.stringify(content),
                },
              ],
              ...(!reasoningEnabled ? { temperature: 0.1 } : {}),
              ...(config.aiProvider === "openai"
                ? {
                    store: false,
                    service_tier: "default",
                    max_completion_tokens: maxTokens,
                    response_format: { type: "json_object" },
                    ...(reasoningEffort
                      ? { reasoning_effort: reasoningEffort }
                      : {}),
                  }
                : {
                    max_tokens: maxTokens,
                    ...(!vision &&
                    model.startsWith("nvidia/nemotron-3.5-lightning-")
                      ? { response_format: { type: "json_object" } }
                      : {}),
                    ...(/^(nvidia\/nemotron-3|qwen\/qwen3|google\/diffusiongemma-)/.test(
                      model,
                    )
                      ? { chat_template_kwargs: { enable_thinking: false } }
                      : {}),
                    ...(model === "z-ai/glm-5.3-flash"
                      ? {
                          reasoning_effort: "low",
                          chat_template_kwargs: { clear_thinking: true },
                        }
                      : {}),
                  }),
            }),
            signal: attemptSignal,
          },
        );
        metric.status = response.status;
        if (response.status === 429 || response.status >= 500) {
          if (config.aiProvider === "openai" && response.status === 429) {
            const details: any = await response.json().catch((caught) => {
              if (attemptSignal.aborted) throw caught;
              return undefined;
            });
            if (
              [
                "insufficient_quota",
                "credit_balance_exhausted",
                "organization_spend_limit_exceeded",
                "project_spend_limit_exceeded",
                "organization_usage_limit_exceeded",
              ].includes(details?.error?.code) ||
              details?.error?.type === "insufficient_quota"
            )
              throw new AppError(
                "ai_quota_exceeded",
                "OpenAI API 額度不足或尚未啟用計費，請檢查 API 帳戶的額度與計費設定。",
                503,
              );
          } else await response.body?.cancel();
          const header = response.headers.get("retry-after");
          const numeric = Number(header || 0) * 1000;
          retryAfterMs =
            header && !Number.isFinite(numeric)
              ? Math.max(0, Date.parse(header) - Date.now())
              : Math.max(0, numeric);
          throw new AppError("ai_busy", "AI 服務忙碌中，請稍後再試。", 503);
        }
        if (response.status === 202) {
          await response.body?.cancel();
          throw new AppError(
            "ai_pending",
            "模型尚未完成，請稍後到處理紀錄查看。",
            503,
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403)
            throw new AppError(
              "ai_auth_error",
              "AI 金鑰或帳號權限無法使用，請檢查後端設定。",
              503,
            );
          if (response.status === 404 || response.status === 410)
            throw new AppError(
              "ai_model_unavailable",
              "目前模型無法使用，請更換後端的模型設定。",
              503,
            );
          throw new AppError(
            "ai_unavailable",
            "AI 服務無法接受目前請求，請檢查模型設定。",
            502,
          );
        }
        // Body consumption is covered by this attempt's abort signal too.
        const body: any = await response.json();
        const usage = body.usage?.total_tokens;
        metric.tokens = Number.isFinite(usage) ? usage : null;
        for (const [key, value] of [
          ["promptTokens", body.usage?.prompt_tokens],
          ["completionTokens", body.usage?.completion_tokens],
          [
            "reasoningTokens",
            body.usage?.completion_tokens_details?.reasoning_tokens,
          ],
        ] as const) {
          if (Number.isSafeInteger(value) && value >= 0) metric[key] = value;
        }
        this.tokens += metric.tokens || 0;
        const choice = body.choices?.[0];
        metric.finishReason = choice?.finish_reason;
        if (
          config.aiProvider === "openai" &&
          (choice?.message?.refusal ||
            choice?.finish_reason === "content_filter")
        )
          throw new AppError(
            "ai_refused",
            "AI 無法完成這次請求，未產生內容；請調整輸入後重試。",
            502,
          );
        if (choice?.finish_reason === "length")
          throw new AppError(
            "ai_output_limit",
            "AI 內容超過回應上限，未顯示不完整結果，請稍後重試。",
            502,
          );
        const value = String(choice?.message?.content || "")
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/```$/, "");
        try {
          const parsed = JSON.parse(value);
          this.unavailableModels.delete(model);
          return parsed;
        } catch {
          throw new AppError(
            "invalid_ai_output",
            "AI 輸出格式無法驗證，請重試。",
            502,
          );
        }
      } catch (caught) {
        if (caught instanceof AppError) error = caught;
        else if (
          attemptSignal.aborted ||
          (caught instanceof Error &&
            (["AbortError", "TimeoutError"].includes(caught.name) ||
              caught.message === "TimeoutError"))
        )
          error = timeout();
        else if (caught instanceof SyntaxError)
          error = new AppError(
            "invalid_ai_output",
            "AI 輸出格式無法驗證，請重試。",
            502,
          );
        else
          error = new AppError(
            "ai_network_error",
            "無法連線到 AI 服務，輸入已保留，請稍後重試。",
            503,
          );
        metric.error = error.code;
      } finally {
        metric.latencyMs = Date.now() - started;
      }
      const transient = ["ai_busy", "ai_timeout", "ai_network_error"].includes(
        error!.code,
      );
      if (transient) this.unavailableModels.add(model);
      if (
        !transient ||
        attempt === 2 ||
        (!hasFallback && error!.code !== "ai_busy")
      )
        throw error!;
      let wait: number;
      if (hasFallback) {
        fallbackFrom = model;
        modelIndex++;
        wait = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
      } else {
        wait = Math.max(
          1000 * 2 ** attempt,
          Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
        );
      }
      if (Date.now() + wait >= deadline) {
        metric.error = "ai_timeout";
        throw timeout();
      }
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    throw timeout();
  }
}
