import { describe, expect, it } from "vitest";
import { publicApiErrorMessage } from "../src/api-error-messages";

describe("public API error guidance", () => {
  it("directs provider configuration failures to support instead of exposing backend settings", () => {
    for (const code of ["ai_auth_error", "ai_model_unavailable", "ai_not_configured"]) {
      const message = publicApiErrorMessage(code, "AI 金鑰或模型設定無法使用，請檢查後端設定。", 503);
      expect(message).toContain("問題回報");
      expect(message).not.toMatch(/金鑰|後端|模型設定|重試/);
    }
  });
  it("does not promise that uncertain transport preserved or rejected the input", () => {
    for (const code of ["network_error", "request_timeout", "invalid_response"]) {
      const message = publicApiErrorMessage(code, "technical transport failure", 503);
      expect(message).toContain("紀錄");
      expect(message).not.toMatch(/已保留|未送出|一定|服務已啟動|暫時/);
    }
  });
  it("distinguishes the daily application limit from provider billing capacity", () => {
    const daily = publicApiErrorMessage("quota_exceeded", "limit", 429);
    const provider = publicApiErrorMessage("ai_quota_exceeded", "billing", 503);
    expect(daily).toContain("今天");
    expect(daily).toContain("勿重複送出");
    expect(provider).toContain("問題回報");
    expect(provider).not.toContain("今天");
    expect(daily + provider).not.toMatch(/明日|明天|不扣|已保留|重置/);
  });
  it("asks for the missing product or source prerequisite before another request", () => {
    expect(publicApiErrorMessage("identity_unconfirmed", "", 409)).toContain("實際藥袋或包裝");
    for (const code of ["source_unavailable", "source_requires_review"]) {
      const message = publicApiErrorMessage(code, "", 422);
      expect(message).toContain("來源狀態");
      expect(message).not.toMatch(/稍後重試|重新送出即可|切勿服用|不扣額度/);
    }
  });
  it("keeps failed processing guidance usable before any medication or official source is saved", () => {
    for (const code of ["invalid_ai_output", "ai_output_limit"]) {
      const message = publicApiErrorMessage(code, "synthetic validation failure", 502);
      expect(message).toContain("系統這次");
      expect(message).toContain("處理紀錄與恢復");
      expect(message).toContain("可用操作");
      expect(message).not.toMatch(/官方仿單|不合格|未通過|已保留|不扣|重試即可/);
    }
  });
  it("keeps a refusal as a refusal rather than suggesting rewording to bypass it", () => {
    const message = publicApiErrorMessage("ai_refused", "refused", 502);
    expect(message).toContain("無法提供回答");
    expect(message).toContain("醫師、藥師");
    expect(message).not.toMatch(/換個問法|重新送出|重試|暫時/);
  });
  it("preserves a specific unknown business or safety explanation even on a 5xx status", () => {
    const message = "來源的適用條件無法確認，請先核對原文。";
    expect(publicApiErrorMessage("new_source_hold", message, 503)).toBe(message);
  });
  it("does not expose an unknown technical response or an inherited object property", () => {
    const message = publicApiErrorMessage("__proto__", "internal stack: synthetic-provider-detail", 500);
    expect(message).toContain("操作未完成");
    expect(message).not.toMatch(/stack|provider|暫時|重試/);
  });
  it("keeps unknown permission and rate-limit failures distinct from service outages", () => {
    expect(publicApiErrorMessage("new_permission_gate", "", 403)).toContain("權限");
    expect(publicApiErrorMessage("new_capacity_gate", "", 429)).toContain("限制");
    expect(publicApiErrorMessage("new_capacity_gate", "", 429)).not.toMatch(/服務暫時|重試/);
  });
});
