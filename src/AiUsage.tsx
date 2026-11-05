import { useEffect, useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import type { AiUsage as Usage } from "../shared/ai-usage";
import { api } from "./api";
import { onAiUsageChanged } from "./ai-usage-events";
import "./AiUsage.css";

export function AiUsage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let version = 0;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const requestVersion = ++version;
      try {
        const next = await api<Usage>("/ai/usage");
        if (
          !next?.personal ||
          !next.global ||
          !Number.isFinite(next.available) ||
          !Number.isFinite(Date.parse(next.resetsAt)) ||
          !Number.isFinite(Date.parse(next.checkedAt))
        )
          throw new Error("Invalid usage response");
        if (!active || requestVersion !== version) return;
        setUsage(next);
        setError(false);
        clearTimeout(resetTimer);
        // Use server time for the reset countdown, even if the device clock differs.
        const resetIn = Date.parse(next.resetsAt) - Date.parse(next.checkedAt);
        resetTimer = setTimeout(
          () => void load(),
          Math.max(1000, resetIn + 500),
        );
      } catch {
        if (active && requestVersion === version) setError(true);
      }
    };
    const update = () => void load();
    const visible = () => {
      if (document.visibilityState === "visible") update();
    };
    const interval = setInterval(visible, 60000);
    const stop = onAiUsageChanged(update);
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    document.addEventListener("visibilitychange", visible);
    update();
    return () => {
      active = false;
      version++;
      stop();
      clearInterval(interval);
      clearTimeout(resetTimer);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const unavailable = usage?.access !== "ready";
  return (
    <section className="ai-usage" aria-label="AI 使用次數">
      <div className="ai-usage-heading">
        <Sparkles size={19} aria-hidden="true" />
        <strong aria-live="polite" aria-atomic="true">
          {error ? (
            "暫時無法確認 AI 剩餘次數"
          ) : !usage ? (
            "正在讀取 AI 剩餘次數…"
          ) : (
            <>
              今日 AI {unavailable ? "額度剩" : "還可使用"}{" "}
              <span>{usage.available}</span> 次
            </>
          )}
        </strong>
        <button
          type="button"
          className="ai-usage-refresh"
          onClick={() => setRefresh((n) => n + 1)}
          aria-label="更新 AI 剩餘次數"
        >
          <RefreshCw size={15} aria-hidden="true" />
          更新
        </button>
      </div>
      {!error && usage && (
        <>
          <p className="ai-usage-counts">
            個人額度：剩 {usage.personal.remaining}／每日 {usage.personal.limit}{" "}
            次
            <span>
              全站共用：剩 {usage.global.remaining}／每日 {usage.global.limit}{" "}
              次
            </span>
          </p>
          <p className="ai-usage-reset">
            每日台北時間 00:00 恢復；全站剩餘次數會隨其他人的使用而減少。
          </p>
          {unavailable && (
            <p className="ai-usage-message">
              {usage.access === "email_unverified"
                ? "請先完成信箱驗證，才能使用 AI。"
                : usage.access === "not_eligible"
                  ? "此帳號尚未開放 AI 使用資格。"
                  : "AI 服務目前尚未設定，暫時無法使用。"}
            </p>
          )}
          {!unavailable && usage.available === 0 && (
            <p className="ai-usage-message">
              {usage.personal.remaining === 0
                ? "你今天的 AI 次數已用完。"
                : "全站今天的 AI 次數已用完，你的個人剩餘次數仍保留。"}
              可繼續查看已保存的說明、官方原文，或手動新增藥品。
            </p>
          )}
          <details>
            <summary>哪些操作會使用次數？</summary>
            <p>
              照片辨識、產生或補充衛教說明、用藥問答及交互作用查詢，共用這份額度。每建立一筆新的
              AI 任務使用 1
              次；已受理但處理失敗的任務也計次。重新讀取已保存結果及系統重試原任務，不會再使用次數。重新上傳照片會建立新任務。
            </p>
          </details>
        </>
      )}
      {error && (
        <p className="ai-usage-message">
          請確認連線後按「更新」；目前不顯示可能已過期的剩餘次數。
        </p>
      )}
    </section>
  );
}
