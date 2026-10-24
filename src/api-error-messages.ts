/** Public wording only: error identity, status and transport behaviour stay with callers. */
const messages: Record<string, string> = {
  network_error: "目前無法連線。請確認網路；若剛送出資料，請先查看相關紀錄，再決定是否重新操作。",
  request_timeout: "等候回應超過時間。請確認網路；若已送出資料，先到相關紀錄確認狀態。",
  invalid_response: "這次回應無法讀取。若剛送出資料，請先查看相關紀錄；仍無法操作時，請聯絡管理員。",
  invalid_ai_output: "系統這次沒能整理出可用內容。請到「處理紀錄與恢復」查看狀態及可用操作。",
  ai_output_limit: "系統這次沒能整理出可用內容。請到「處理紀錄與恢復」查看狀態及可用操作。",
  ai_timeout: "這次 AI 處理等候過久，未取得可用結果。請到處理紀錄確認，避免重複送出。",
  ai_network_error: "這次未能連上 AI 處理服務。請先到處理紀錄確認狀態，避免重複送出。",
  ai_pending: "這次 AI 處理尚未取得可用結果。請到處理紀錄確認，避免重複送出。",
  ai_busy: "AI 處理服務目前忙碌。請先查看處理紀錄，勿連續重複送出。",
  ai_unavailable: "AI 處理服務未能完成這次操作。請先查看處理紀錄；若持續發生，可使用「問題回報」。",
  ai_not_configured: "AI 整理功能尚未能使用。請透過「問題回報」告知我們；重複送出相同內容無法解決此問題。",
  ai_auth_error: "AI 整理功能目前無法使用。請透過「問題回報」告知我們；重複送出相同內容無法解決此問題。",
  ai_model_unavailable: "AI 整理功能目前無法使用。請透過「問題回報」告知我們；重複送出相同內容無法解決此問題。",
  ai_quota_exceeded: "AI 服務的使用額度不足，這次無法完成。請透過「問題回報」告知我們，勿重複送出相同內容。",
  ai_refused: "這次請求無法提供回答。可查閱官方仿單，或向醫師、藥師詢問；請勿據此自行調整用藥。",
  quota_exceeded: "今天的 AI 使用額度已達上限，請勿重複送出。可先查看既有紀錄與官方來源狀態。",
  identity_unconfirmed: "這款藥的產品資料還沒核對完成。請依實際藥袋或包裝補齊產品資料，再使用仿單功能。",
  source_unavailable: "這款藥還沒有可使用的官方仿單。請到藥品頁查看來源狀態；重送相同請求不會補齊來源。",
  source_requires_review: "這款藥的官方仿單仍待整理。請到藥品頁查看來源狀態與可用原文，勿反覆送出相同請求。",
  queue_unavailable: "這次操作尚未確認排入處理。請先查看處理紀錄，避免重複建立。",
  service_busy: "服務目前忙碌。請先查看相關紀錄，確認這次操作的狀態，勿連續送出。",
};

export function publicApiErrorMessage(code: unknown, message: unknown, status = 0): string {
  if (typeof code === "string" && Object.hasOwn(messages, code)) return messages[code];
  // Existing business errors can name a specific missing field, source or safety hold.
  // Keep that public explanation instead of replacing every unknown code with an outage.
  if (typeof message === "string" && /\p{Script=Han}/u.test(message) && message.trim()) return message;
  if (status === 401) return "登入狀態無法確認，請重新登入。";
  if (status === 403) return "此帳號目前無法執行這項操作。請確認登入帳號與權限。";
  if (status === 404) return "找不到這筆資料或功能。請回到清單重新開啟。";
  if (status === 409) return "資料與目前狀態不一致。請重新讀取資料後再操作。";
  if (status === 429) return "操作次數或處理量已達限制。請依畫面限制資訊處理，勿連續重送。";
  if (status >= 400 && status < 500) return "有些資料無法確認。請核對畫面欄位與目前狀態後再操作。";
  return "這次操作未完成。請先確認相關紀錄；若持續發生，請聯絡管理員。";
}
