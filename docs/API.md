# API 與資料設計

Base path：`/api/v1`。除 `/config`、本機專用 `/auth/local` 與 `/health` 外均需 `Authorization: Bearer FIREBASE_ID_TOKEN`。正式環境每次驗證 token 的撤銷狀態；資料擁有者由 token UID 決定，body 的任意 `ownerId` 不作存取依據。

## 端點

| 路徑                                       | 方法                     | 用途                                            |
| ------------------------------------------ | ------------------------ | ----------------------------------------------- |
| `/me`                                      | GET / PUT / DELETE       | 個人帳號／健康資料、修改、背景刪除              |
| `/me/export`                               | GET                      | 下載個人資料 JSON                               |
| `/auth/google-profile`                     | POST                     | 核對Google憑證與目前Firebase UID，僅補齊缺少的信箱 |
| `/medications`、`/medications/:id`         | GET / POST、PUT / DELETE | 藥品草稿、確認、編輯、封存                      |
| `/medications/identity-check`              | POST                     | 以另抄的包裝資料核對產品；不建立 AI 工作或扣額 |
| `/drugs/search?q=`                         | GET                      | 版本化官方主檔搜尋                              |
| `/recognitions`                            | POST                     | JPEG／PNG base64，8 MB 以內；回傳長任務         |
| `/recognitions/:id/medications/:index`     | POST                     | 從本人成功辨識結果逐筆核對保存；重送不新增或覆寫 |
| `/bundles`、`/chat`、`/interactions`       | POST                     | 藥品 ID 集合與問題，回傳長任務；交互作用限兩款  |
| `/chat`                                    | GET                      | 自己的問答歷史                                  |
| `/jobs`、`/jobs/:id`                       | GET                      | 最近 100 筆摘要／單筆重新核對後的結果；隱藏 input |
| `/jobs/:id/retry`                          | POST                     | 重試失敗的文字任務，照片需重新上傳              |
| `/learning`                                | GET                      | 仍符合內容規則／健康／藥品／仿單版本的說明與測驗 |
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

HTTP 202 後輪詢 `/jobs/:id`；狀態為 queued、running、succeeded 或 failed。Worker 使用到期 lease 避免同時執行。每次生成、審核或辨識最多 3 個 HTTP 嘗試，模型切換也計入，並共用該次 45 秒及任務 120 秒期限；有備援時文字優先模型最多 12 秒（`AI_TEXT_PRIMARY_TIMEOUT_MS`）、影像最多 22 秒（`AI_PRIMARY_TIMEOUT_MS`），依剩餘時間縮短。圖片資料短期留存，辨識失敗也刪除照片；畫面保留選取的 File，使用者可以重新上傳。

`Job.aiRequests` 持久化逐次 `provider`、`model`、`stage`（vision／generation／verification）、`attempt`、`latencyMs`、`status`、`tokens`、`finishReason`、`error` 與可選 `fallbackFrom`。`tokens=null` 表示上游未回傳用量，不能從任務總數預設零推斷零消耗。快取身份包含依序模型路由、12／22 秒設定與 `nvidia-fallback-v2`／`literal-conditions-v1` 政策；暫時性故障才切同供應商備援，JSON／結構驗證、截斷或金鑰權限錯誤不藉切換掩蓋。本文讀取拋錯時以 `attemptSignal.aborted` 檢查期限，避免中止後的 `TypeError` 被錯記為網路故障。`GET /config` 另提供無金鑰的 `aiTextFallbackModels`／`aiVisionFallbackModels`，設定見 [README](../README.md#ai-供應商與本機設定)。

核准的 `Claim` 可另含後端計算的 `sourceMentions: ProfileReference[]`：僅 `conditions`，該值至少兩個字，須同時逐字出現在本條警語與自身已核對引用，且在內容核准後才加入；模型自行輸出的同名欄位不採用。它不等同於語意審核通過的 `profileRefs`，不恢復遭拒的個人化標籤，亦不推論因果或個人適用性。

定時打卡的識別碼由排程 ID、藥品 revision 與到期時間決定；PRN 使用 UUID `operationId`。重複相同紀錄不新增資料；修改狀態另存 `doseCorrections`，藥品封存後仍可更正既有紀錄。

## 已完成辨識的核對續接

`POST /recognitions/:id/medications/:index` 的 body 沿用藥品建檔格式，由使用者逐欄核對；`index` 為從 0 起算的辨識結果索引。後端要求此任務屬於本人、類型為 recognition、狀態為 succeeded，且該索引確實存在。其他人的任務回 404；尚未成功或無效結果回 `invalid_recognition`。

保存藥品與 `Job.savedMedications[index] = {id,name}` 在同一筆交易內完成，藥品識別由 UID、辨識任務及索引決定。回應遺失後重送、同頁重複點擊或另一分頁重送，均回傳原藥品，不新增第二筆，也不以重送 body 覆寫已保存的內容。已封存的同筆藥品不會被重新建立；有保存對應但找不到藥品時回 `409 already_saved`。成功與重送回應均為 201 與藥品物件。

使用者可從「AI 處理紀錄 → 繼續核對辨識結果」開啟成功任務，前端略過已保存索引，接續其餘結果。重新登入或服務重啟後仍可續接，不重新呼叫辨識模型；失敗辨識仍需重新上傳照片。

## 產品資料不足與仿單連結

`confirmed` 表示使用者已核對用法。連結仿單還需要獨立的包裝資料；搜尋分數、選取候選、已有仿單及辨識信心都不會自動完成產品核對。

`identityEvidence` 可留空或保存部分抄錄內容。核對方式為 `method:"license"`，使用 `printedLicenseNo` 抄完整許可證（包含前綴）；或 `method:"details"`，使用 `printedName`、`printedStrength`、`printedForm` 抄完整品名、含量與劑型。後者必須與完整官方目錄中的單一產品一致，保留廠牌、口味、含量與劑型差異，不換算濃度。官方含量或劑型不完整時，需改用完整許可證。

`POST /medications/identity-check` 接受上述資料及可選的 `candidateLicenseNo`，回傳 `identityReview`（`status:"confirmed" | "needs_information"`、`message`、`missingFields` 與候選完整資料）。這是對抄錄資料與目錄的一致性核對；包裝真偽與抄錄來源由使用者對照。介面不預填核對證據，資料不足時提示補拍完整藥袋、外盒或瓶身，或向原調劑院所補資料。

兩個存藥入口都重新執行伺服器核對。待核對資料的 `licenseNo` 為 `null`，所選候選保存在 `candidateLicenseNo`，用量、頻次及部分抄錄仍可保存接續。只有核對成功才設定正式 `licenseNo`；回傳的 `identityReview` 由伺服器計算，客戶端傳入成功標記不能取代證據。舊資料沒有核對證據時，同樣回傳待核對狀態，讀取過程不自動改寫或遷移資料。

仿單、測驗、問答及交互作用在入列與扣額前檢查產品及用法。產品尚未核對回 `409 identity_unconfirmed`，不新增工作、不扣 AI 額度；worker、快取、重試與完成寫入時也會重新檢查。失效的舊學習及問答不再當成可用內容展示，問答列表會附 `hiddenUnsafeCount` 與補資料提示。

`GET /jobs` 的辨識結果仍可供核對續接；其他工作僅提供摘要，`result:null`，成功工作附 `resultRequiresCheck:true`。使用者展開結果時才呼叫 `GET /jobs/:id` 重新核對，避免每次輪詢對所有歷史逐筆讀取。無法核對的單筆結果回空內容及 `identityReviewRequired:true`，保留原執行狀態。收合再展開會重新檢查，不重用先前核對過的回答。

編輯已保存藥品沿用既有提醒規則：保存後停用原提醒，包含只補齊產品資料的修改；介面會提醒重新確認時間並排定。產品待核對仍可按本人已確認用法保存紀錄及設定提醒。

## 衛教與學習進度（2026-10-11）

`Claim` 可附 `category: purpose | use | warning | other` 與 `profileRefs: [{field,value}]`。參照欄位限 age、sex、conditions、allergies、pregnancy，只有明確值匹配且警語相關性通過核對時回傳。舊內容缺少這些欄位仍可顯示。新 bundle 最多兩題，chat／interaction 回傳空 quiz。

`GET /learning` 保留原欄位，另附 `progress`，依建立時間由新到舊排列。沒有測驗時狀態為 unavailable，未開始為 not_started，曾作答但尚未全對為 in_progress，全部答對為 completed。進度由有效已提交答案計算。

`POST /learning/:id/answers` 的原整份格式仍可使用，也可單題提交：

```json
{ "answers": { "q0": 1 } }
```

交易內合併既有答案；空物件不清除答案。題目不存在或選項超出範圍回 `400 invalid_answer`，不儲存部分有效輸入。資料版本已更新回 `409 stale_content`；紀錄已刪除或不屬於自己回 404。回傳原 `results` 及合併後 `answers`、`progress`：

```json
{
  "answers": { "q0": 1 },
  "results": [
    {
      "id": "q0",
      "state": "incorrect",
      "correct": false,
      "answer": 0,
      "explain": "來源說明"
    },
    {
      "id": "q1",
      "state": "unanswered",
      "correct": false,
      "answer": 0,
      "explain": "來源說明"
    }
  ],
  "progress": {
    "total": 2,
    "answered": 1,
    "correct": 0,
    "passed": false,
    "status": "in_progress",
    "results": [
      {
        "id": "q0",
        "state": "incorrect",
        "correct": false,
        "answer": 0,
        "explain": "來源說明"
      },
      {
        "id": "q1",
        "state": "unanswered",
        "correct": false,
        "answer": 0,
        "explain": "來源說明"
      }
    ]
  }
}
```

學習紀錄的 passed 同步更新，提醒與服藥紀錄不依 passed 決定可用性。

2026-10-19 起，新的 `LearningRecord.groundingVersion` 保存建立當時的 `GROUNDING_VERSION`。列表與答題交易均要求規則版本一致；缺少此欄位的舊紀錄保留在資料庫，但不再列為目前可作答內容，提交回 `409 stale_content`。重新產生會建立新的紀錄，不搬移舊答案。歷史 AI 處理紀錄可查看當時說明，但不提供舊題作答。

目前規則 `grounded-v9-source-quote-explanations` 保留組成數量與單方／複方的自身引用檢查，且正式 `quiz.explain` 由後端依已確認引用組成，附 `explanationKind: "source_quote"`；不是模型自由生成的解釋。模型只需提供題幹、選項、正解、來源連結及條件 metadata，若仍輸出自由 `explain`，原始回應保留於診斷，該欄不供正式顯示。獨立語意核對與所有選項唯一答案檢查仍保留，驗證輸入只含每項自己的引用及父條件，不附全部未引用來源。v7／v8 內容保留作歷史，但不能當成 v9 可作答內容。

## 錯誤回應

```json
{
  "code": "quota_exceeded",
  "message": "今日 AI 使用額度已達上限。",
  "requestId": "opaque-request-id"
}
```

常見代碼：unauthenticated、account_disabled、forbidden、email_unverified、not_eligible、quota_exceeded、ai_busy、ai_timeout、ai_quota_exceeded、ai_refused、invalid_ai_output、verification_failed、stale_content。`ai_quota_exceeded` 表示 OpenAI 明確帳戶額度／計費限制，與本系統每日 `quota_exceeded` 分開，停止重試；refusal 或 content_filter 為 `ai_refused`，不發布內容，也不切 NVIDIA。暫時限流與 5xx 才依既有期限重試。缺仿單回 `insufficient_data` 結果，不憑空填內容。生產日誌不含完整請求或模型原文。

## 資料集合與隔離

私人集合：users、profiles、medications、schedules、doseLogs、doseCorrections、cabinet、chats、learning、generated、devices、invites、inviteAttempts、notifications、jobs。多數以 `ownerId` 篩選；profile 與 users 以 UID 作 doc ID。

relationships 保存 ownerId／caregiverId／active；published 保存許可證對應当前仿單；leaflets 保存版本、hash、來源、頁碼及段落；settings 保存索引指標、名額及成分別名；usage 保存 UID／全站每日任務數；audit 保存管理操作人、動作、目標與時間。

Firestore／Storage client rules 一律拒絕，後端用服務帳戶訪問。Firestore 不存圖片 base64：圖片在短期 Storage，工作完成後刪除。私人內容不寫入前端 localStorage 或 Service Worker cache。應用自行管理的 sessionStorage 包括本機模式登入token、裝置識別、不含健康文字的任務接續識別及Google登入核對狀態；Firebase SDK自行管理登入紀錄，應用不另存Google／Firebase憑證。未送出的問題與健康資料草稿仍留在記憶體。

Firebase由 `createSessionFirebaseAuth` 在 `initializeAuth` 時設定 `[browserSessionPersistence, inMemoryPersistence]`，優先使用分頁儲存，不可用時改用記憶體保存。有 `/config.googleOAuthClientId` 時，前端載入Google官方GIS按鈕，取得Google ID token後呼叫Firebase `signInWithCredential`；此模式不初始化Firebase登入iframe resolver。使用Firebase Bearer token呼叫 `POST /auth/google-profile`，body僅接受 `{googleIdToken}`；後端驗證Google token的audience、issuer、時效、已驗證信箱及subject與Firebase目前UID的provider對應，不接受客戶端指定UID、不按信箱合併帳號。核對、刷新token及 `/me` 完成後才顯示已登入。

GIS按鈕載入期限15秒，憑證交換至帳號讀取共用30秒期限。每個有效按鈕掛載僅接收一次對應回呼；重複、卸載後或其他登入進行中的回呼會忽略。逾時會清除應用身份與token提供者、阻止晚到結果恢復登入，背景登出不阻塞錯誤畫面；使用者可重新載入登入頁後再試或使用Email。Google／Firebase token不另寫入應用自訂儲存，登入紀錄由Firebase SDK管理。

缺少公開client ID的舊路徑仍使用redirect：共用一次 `getRedirectResult`，先核對再觀察身份，返回初始化及首次帳號讀取共用30秒期限。沒有redirect結果的普通開頁是正常情況，也不一定能區分一般開頁與流程中斷；這不代表缺少OAuth後端設定仍可成功登入。同一分頁重新整理可由SDK接續已完成核對的登入；若分頁儲存不可用而改用記憶體保存，重新整理後可能需重登，伺服器中的健康資料不受影響。此機制不提供跨瀏覽器登入狀態轉移，其他瀏覽器須自行完成正式登入。Google／Firebase SDK仍管理各自短期流程狀態，不能把「應用不自存token」解讀為瀏覽器完全不使用storage。「帳號與設定」的明確Google帳號連結仍使用獨立popup；程式測試與真實驗收狀態分開記錄於[部署文件](DEPLOYMENT.md)。

## 內部端點

`POST /internal/jobs/:id`、`/internal/tick`、`/internal/catalog` 需要 Google OIDC service account token，audience 精確符合 worker URL，email 精確符合 caller service account。Firebase 使用者 token 不能呼叫內部 worker。
