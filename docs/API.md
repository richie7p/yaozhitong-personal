# API 與資料設計

Base path：`/api/v1`。除 `/config`、本機專用 `/auth/local` 與 `/health` 外均需 `Authorization: Bearer FIREBASE_ID_TOKEN`。正式環境每次驗證 token 的撤銷狀態；資料擁有者由 token UID 決定，body 的任意 `ownerId` 不作存取依據。

## 端點

| 路徑                                       | 方法                     | 用途                                            |
| ------------------------------------------ | ------------------------ | ----------------------------------------------- |
| `/me`                                      | GET / PUT / DELETE       | 個人帳號／健康資料、修改、背景刪除              |
| `/me/export`                               | GET                      | 下載個人資料 JSON                               |
| `/medications`、`/medications/:id`         | GET / POST、PUT / DELETE | 藥品草稿、確認、編輯、封存                      |
| `/drugs/search?q=`                         | GET                      | 版本化官方主檔搜尋                              |
| `/recognitions`                            | POST                     | JPEG／PNG base64，8 MB 以內；回傳長任務         |
| `/bundles`、`/chat`、`/interactions`       | POST                     | 藥品 ID 集合與問題，回傳長任務；交互作用限兩款  |
| `/chat`                                    | GET                      | 自己的問答歷史                                  |
| `/jobs`、`/jobs/:id`                       | GET                      | 自己最近 100 筆任務／單筆進度及結果，隱藏 input |
| `/jobs/:id/retry`                          | POST                     | 重試失敗的文字任務，照片需重新上傳              |
| `/learning`                                | GET                      | 仍符合健康／藥品／仿單版本的說明與測驗          |
| `/learning/:id/answers`                    | POST                     | 答案與解釋，可重答；不阻擋提醒                  |
| `/schedules`                               | GET / POST               | 每日提醒時間、日期與台北時區                    |
| `/today`                                   | GET                      | 今日排程及打卡狀態                              |
| `/dose-logs`、`/dose-logs/:id`             | GET / POST、PATCH        | 歷史查詢、新增／更正；保留更正稽核              |
| `/cabinet`、`/cabinet/:id`                 | GET / POST、PUT          | 存量、效期、處理狀態                            |
| `/care`、`/care/invites`、`/care/accept`   | GET、POST、POST          | 照護關係、產生與接受一次性邀請                  |
| `/care/:id`                                | DELETE                   | 授權者撤銷關係                                  |
| `/care/:ownerUid/snapshot`                 | GET                      | 有效照護關係的唯讀摘要                          |
| `/devices`、`/devices/:id`                 | POST、DELETE             | 註冊／撤銷本裝置 FCM token                      |
| `/notifications`                           | GET                      | 自己的通知狀態                                  |
| `/admin/users`、`/admin/users/:id`         | GET、PATCH               | 帳號搜尋，停用／恢復及測試資格                  |
| `/admin/leaflets`                          | GET / POST               | 仿單列表與官方 PDF 上傳草稿                     |
| `/admin/leaflets/:id/text`、`/:id/publish` | PUT、POST                | 草稿逐頁文字修正、確認發布                      |
| `/admin/usage`、`/admin/audit`             | GET                      | 最小化任務資訊／每日數量、管理稽核              |
| `/admin/jobs/:id/retry`                    | POST                     | 管理員重試；不回傳私人輸入／結果                |
| `/admin/ingredient-aliases`                | PUT                      | 人工成分別名映射表                              |

管理 API 需 `admin:true` custom claim。後端不提供一般使用者提升管理員角色的端點。Cloud Run worker 不提供私人網頁 API。

## 長任務與冪等

AI 請求必須有 `Idempotency-Key`（8–100 字元的英數／連字號）。相同 UID、任務類型、key 的相同輸入重用 job；不同輸入回 `409 idempotency_conflict`。建立任務與扣每日次數在同一筆資料庫交易。

```json
{ "jobId": "opaque-id", "status": "queued" }
```

HTTP 202 後輪詢 `/jobs/:id`；狀態為 queued、running、succeeded 或 failed。Worker 使用到期 lease 避免同時執行，最多三次一般 AI 嘗試。認識到圖片資料應短期留存，所以辨識失敗也刪除照片；畫面保留選取的 File，使用者可以重新上傳。

定時打卡的識別碼由排程 ID、藥品 revision 與到期時間決定；PRN 使用 UUID `operationId`。重複相同紀錄不新增資料；修改狀態另存 `doseCorrections`，藥品封存後仍可更正既有紀錄。

## 錯誤

```json
{
  "code": "quota_exceeded",
  "message": "今日 AI 使用額度已達上限。",
  "requestId": "opaque-request-id"
}
```

常見代碼：unauthenticated、account_disabled、forbidden、email_unverified、not_eligible、quota_exceeded、ai_busy、ai_timeout、invalid_ai_output、verification_failed、stale_content。缺仿單回 `insufficient_data` 結果，不憑空填內容。生產日誌不含完整請求或模型原文。

## 資料集合與隔離

私人集合：users、profiles、medications、schedules、doseLogs、doseCorrections、cabinet、chats、learning、generated、devices、invites、inviteAttempts、notifications、jobs。多數以 `ownerId` 篩選；profile 與 users 以 UID 作 doc ID。

relationships 保存 ownerId／caregiverId／active；published 保存許可證對應当前仿單；leaflets 保存版本、hash、來源、頁碼及段落；settings 保存索引指標、名額及成分別名；usage 保存 UID／全站每日任務數；audit 保存管理操作人、動作、目標與時間。

Firestore／Storage client rules 一律拒絕，後端用服務帳戶訪問。Firestore 不存圖片 base64：圖片在短期 Storage，工作完成後刪除。私人內容不寫入前端 localStorage 或 Service Worker cache；登入 token 和裝置識別的 sessionStorage 只用於本機登入／裝置管理，Firebase token 使用記憶體。

## 內部端點

`POST /internal/jobs/:id`、`/internal/tick`、`/internal/catalog` 需要 Google OIDC service account token，audience 精確符合 worker URL，email 精確符合 caller service account。Firebase 使用者 token 不能呼叫內部 worker。
