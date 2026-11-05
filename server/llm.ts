import type { Llm } from "./ai.js";
import type { AiRequestMetric } from "../shared/schema.js";
import type { Drug } from "../shared/schema.js";
import type { ReferenceSearch } from "../shared/assistance.js";
import { REFERENCE_DOMAINS } from "../shared/assistance.js";
import { referenceSearchRequest, referenceSearchCandidates, canonicalReferenceUrl } from "./reference-search.js";
import { readReferenceContent } from "./reference-content.js";
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

  async searchReferences(drugs: Drug[]): Promise<ReferenceSearch> {
    const unavailable: ReferenceSearch = { state: "unavailable", sources: [], passages: [] };
    if (config.aiProvider !== "openai" || !config.openaiKey || !drugs.length) return unavailable;
    // One recovery search when the first search yielded no readable, matching
    // cited original (uncited background hits alone may be inventories).
    // Both attempts share the job deadline; reserve time
    // for generation/review, and do not retry provider errors or quota failures.
    let last = unavailable;
    let previousCandidates: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = this.startedAt + config.aiJobTimeoutMs - Date.now();
      if (remaining < (attempt === 1 ? 10000 : 90000)) return last;
      const started = Date.now();
      const metric: AiRequestMetric = { provider: "openai", model: config.textModel,
        stage: "search", attempt, latencyMs: 0, tokens: null };
      this.requests.push(metric);
      try {
        const request = referenceSearchRequest(drugs, config.textModel);
        if (attempt === 2) {
          const priorHosts = previousCandidates.map((url) => new URL(url).hostname);
          const otherDomains = REFERENCE_DOMAINS.filter((domain) =>
            !priorHosts.some((host) => host === domain || host.endsWith("." + domain)),
          );
          if (otherDomains.length >= 3) request.tools[0].filters.allowed_domains = [...otherDomains];
          request.instructions += "\n這是一次補充搜尋：上一輪未取得可讀、名稱與劑型相符的來源原文。請改用更簡短的公開藥名及劑型搜尋，優先找醫院的藥品資訊 HTML 頁或用藥指導單張，並實際開啟來源。不要只查產品名冊。不要要求使用者先提供個人用法；不得猜成分、變更給藥途徑或以搜尋不到推斷沒有用途。請在允許來源範圍內尋找其他機構，避免重複只回傳前一輪未能提供原文的網址。";
          request.input = JSON.stringify({ ...JSON.parse(request.input), previousCandidateUrls: previousCandidates });
        }
        const response = await fetch(config.openaiBase.replace(/\/$/, "") + "/responses", {
          method: "POST", headers: { authorization: "Bearer " + config.openaiKey, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(attempt === 1
            ? Math.min(60000, Math.floor(remaining / 2))
            : Math.min(45000, remaining - 60000)),
        });
        metric.status = response.status;
        if (!response.ok) { metric.error = "reference_search_unavailable"; return last.passages.length ? last : unavailable; }
        const raw: any = await response.json();
        metric.tokens = Number(raw.usage?.total_tokens) || 0;
        this.tokens += metric.tokens;
        const parsed = referenceSearchCandidates(raw, drugs);
        previousCandidates = parsed.sources.map((source) => source.url);
        const diagnostics = { candidates: parsed.sources.length, originals: 0, outcomes: {} as Record<string, number> };
        metric.referenceRetrieval = diagnostics;
        const readBudget = Math.min(15000, this.startedAt + config.aiJobTimeoutMs - Date.now() - (attempt === 1 ? 10000 : 45000));
        const result = parsed.state === "found" && readBudget > 0
          ? await readReferenceContent(parsed, drugs, {
              signal: AbortSignal.timeout(readBudget),
              onRead: (outcome) => { diagnostics.outcomes[outcome] = (diagnostics.outcomes[outcome] || 0) + 1; },
            })
          : parsed.state === "found" ? unavailable : parsed;
        diagnostics.originals = result.passages.length;
        if (result.state === "unavailable") metric.error = "reference_search_incomplete";
        else if (result.state === "not_found") metric.error = "reference_originals_not_found";
        const citedUrls = new Set<string>((raw.output || []).flatMap((item: any) =>
          item.type === "message" ? (item.content || []).flatMap((part: any) =>
            (part.annotations || []).flatMap((annotation: any) => {
              const url = annotation.type === "url_citation" && canonicalReferenceUrl(annotation.url);
              return url ? [url] : [];
            }),
          ) : [],
        ));
        if (result.passages.length && (attempt === 2 || result.sources.some((source) => citedUrls.has(source.url)))) return result;
        if (parsed.state === "unavailable") return last.passages.length ? last : result;
        if (result.passages.length || !last.passages.length) last = result;
      } catch { metric.error = "reference_search_unavailable"; return last.passages.length ? last : unavailable; }
      finally { metric.latencyMs = Date.now() - started; }
    }
    return last;
  }

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
