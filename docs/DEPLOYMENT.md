# Google Cloud 與 Firebase 部署

部署腳本已準備 OpenAI／NVIDIA 供應商選擇、模型與 Secret Manager 接法，尚未在使用者的雲端帳號實際部署或驗收。實際部署仍需要有效的 Google Cloud 專案、計費帳號、Firebase Web 設定與 FCM Web Push 憑證；本機設定檢查通過不代表已可正式營運。

## 目前狀態（2026-10-20）

目前正式本機版採用 OpenAI `gpt-6-luna`，日常與研討會展示使用同一套介面。`infra/deploy.ps1` 已預設選擇 OpenAI，可明確指定供應商與文字／影像模型；Web 與 worker 會使用同一組供應商、模型及對應 Secret，不自動跨供應商備援。這次只準備程式與文件，**沒有建立雲端資源、執行部署或驗證雲端可用性**。

上雲前尚需完成：

- 設定 Firebase 正式登入、授權網域與管理員；將官方主檔及已核對仿單受控匯入雲端，不把本機測試資料庫整份搬入。
- 在雲端測試專案驗證所選模型的帳號存取權、金鑰與額度，再驗收辨識、仿單、理解測驗、帳號隔離、Cloud Tasks／Scheduler、失敗恢復、推播與備份還原，並建立實際費用通知。

本機展示的驗收結果不代替上述雲端驗收。下方分開列出不連雲端的設定檢查，以及日後才執行的部署指令。

## 環境準備

1. 建立兩個獨立 Google Cloud／Firebase 專案，分別作為測試與正式環境。啟用計費，確認資料地區 `asia-east1` 符合專題需要。
2. 安裝 Google Cloud CLI，登入部署帳號；本機匯入工具用 Application Default Credentials：`gcloud auth application-default login`。不要下載長期服務帳戶金鑰進專案。
3. Firebase Console 建立 Web App，將公開 config 另存 JSON 檔（包括 apiKey、authDomain、projectId、storageBucket、messagingSenderId、appId）。這不是 Admin SDK 私鑰。
4. Authentication 啟用 Google 和 Email／密碼。設定驗證信、密碼重設樣板與授權網域。
5. 為落實「不只憑相同 Email 自動合併」，Authentication 的 User account linking 設為 **Create multiple accounts for each identity provider**。使用者須登入原帳號，從「帳號與設定」明確連結另一登入方式。若另一方式已屬於獨立 UID，介面回傳 Firebase 連結衝突，不會搬移健康資料；需保留原登入方式，不做隱性合併。此設定會影響供應商個人資料回傳，顯示名稱可在健康資料頁自行填寫。[官方設定說明](https://support.google.com/firebase/answer/9134820?hl=en)、[明確連結流程](https://firebase.google.com/docs/auth/web/account-linking)。
6. Cloud Messaging → Web Push certificates 產生公開 VAPID Key。

## 供應商、模型與金鑰

`infra/deploy.ps1` 保留原有參數，並加入供應商、模型與只驗設定模式：

| 參數 | 用途與預設 |
| --- | --- |
| `-ProjectId` | 必填；要部署的 Google Cloud／Firebase 專案 |
| `-FirebaseConfigPath` | 必填；Firebase Web 公開設定 JSON，內含的 `projectId` 必須相符 |
| `-VapidKey` | 必填；FCM Web Push 的公開 VAPID Key |
| `-Environment` | `test`（預設）或 `prod` |
| `-Region` | 預設 `asia-east1` |
| `-AiProvider` | `openai`（預設）或 `nvidia` |
| `-TextModel`／`-VisionModel` | 分別明確指定文字與影像模型；解析順序如下 |
| `-ValidateOnly` | 只輸出去敏設定 JSON，在任何 `gcloud` 指令前返回 |

文字與影像模型各自依下列順序解析，選中的結果會一致寫入 Web／worker 設定：

1. 明確傳入的 `-TextModel`／`-VisionModel`。
2. 目前程序環境的 `AI_TEXT_MODEL`／`AI_VISION_MODEL`。
3. 所選供應商專用的模型環境變數。
4. 下表的腳本預設模型。

| 供應商 | 專用模型環境變數 | 文字／影像預設模型 | 實際部署所需金鑰環境變數 | Secret 名稱 |
| --- | --- | --- | --- | --- |
| `openai` | `OPENAI_TEXT_MODEL`／`OPENAI_VISION_MODEL` | 兩者皆為 `gpt-6-luna` | `OPENAI_API_KEY` | `yzt-test-openai-key`／`yzt-prod-openai-key` |
| `nvidia` | `NVIDIA_TEXT_MODEL`／`NVIDIA_VISION_MODEL` | 兩者皆為 `nvidia/nemotron-3.5-super-vl-120b-a12b` | `NVIDIA_API_KEY` | `yzt-test-nvidia-key`／`yzt-prod-nvidia-key` |

腳本**不會自動載入 `.env`**；模型覆寫與實際部署所需金鑰必須存在於執行腳本的程序環境。只要求所選供應商的金鑰；選 OpenAI 不要求 NVIDIA 金鑰，反之亦然。部署前先查看 `-ValidateOnly` 的解析結果，避免目前程序殘留的通用 `AI_*_MODEL` 蓋過專用設定。

本次只支援上述模型覆寫，不會將整份本機環境設定搬上雲端。部署明確沿用目前請求／影像主模型／文字主模型／任務的 45／22／12／120 秒期限，以及文字 2,400／影像 2,600 token 回覆上限；OpenAI 思考設定仍沿用應用程式的 `none`。供應商端點固定為官方 `https://api.openai.com/v1` 或 `https://integrate.api.nvidia.com/v1`，不採用終端中自訂的 `OPENAI_BASE_URL`／`NVIDIA_BASE_URL`。

實際部署時，金鑰只透過標準輸入上傳至對應 Secret Manager Secret，再提供給兩個後端服務；不放入部署參數、產生的環境設定檔、前端或日誌。OpenAI 建議在伺服器端由環境變數或金鑰管理服務載入金鑰；Cloud Run 的 Secret 設定與存取權限仍須在日後部署時驗證。[OpenAI API 官方驗證說明](https://developers.openai.com/api/reference/overview)、[Cloud Run Secret 官方說明](https://docs.cloud.google.com/run/docs/configuring/services/secrets)。

## 只檢查設定，不部署

在儲存庫根目錄執行，先準備與測試專案相符的 Firebase Web 設定檔：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider openai -ValidateOnly
```

若要確認明確模型參數的優先順序：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -AiProvider openai -TextModel gpt-6-luna -VisionModel gpt-6-luna -ValidateOnly
```

`-ValidateOnly` 可在沒有 Google Cloud CLI、沒有供應商金鑰的環境執行；仍需提供上述必要參數與本機設定檔。它只驗證可在本機檢查的設定並輸出去敏 JSON，**不執行任何 `gcloud`、不建立資源、不上傳 Secret、不呼叫模型**，也不驗證金鑰有效性、模型存取權／額度、計費或雲端權限。

部署腳本另有完整離線回歸：

```powershell
./tools/check-deployment.ps1
```

這項回歸使用假金鑰與模擬 CLI，檢查模型解析、去敏設定、Secret 輸入及兩個服務的部署參數；不連雲端、不使用真正的 Google Cloud CLI 或金鑰，也不能代替實際雲端驗收。

## 日後實際部署

以下指令會建立或更新雲端資源，本次尚未執行。先完成環境準備與設定檢查，再在部署程序環境安全設定所選供應商的金鑰；不要把金鑰文字寫進範例或命令歷史。

OpenAI 測試專案範例：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider openai -TextModel gpt-6-luna -VisionModel gpt-6-luna
```

若日後明確選用 NVIDIA，先在目前程序環境設定 `NVIDIA_API_KEY`，再執行相同流程：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider nvidia -TextModel 'nvidia/nemotron-3.5-super-vl-120b-a12b' -VisionModel 'nvidia/nemotron-3.5-super-vl-120b-a12b'
```

腳本建立／更新：

- Web Cloud Run：提供網站和 `/api/v1`，公開網路可達，私人 API 仍驗證 Firebase ID Token。
- Worker Cloud Run：Cloud Run IAM 私有，另外驗證 OIDC audience 和指定 service account email。
- Runtime／caller service accounts、Cloud Tasks、每分鐘到期檢查及每週日台北 03:00 主檔更新。
- 非公開 Cloud Storage、上傳區一天生命週期、所選供應商的 Secret、Firestore 每日備份保留 7 天。
- Cloud Run 最少 0、每個服務最多 2 個執行個體。Web 120 秒、worker 600 秒逾時。

兩個環境需使用不同 `ProjectId`；只改 `Environment` 名稱並不能隔離 Firebase Authentication 和預設 Firestore。

完成後，把輸出的 Web Cloud Run 網域加入 Firebase Auth 授權網域。使用 HTTPS；worker URL 不提供給瀏覽器。

## 規則、管理員與資料

部署 Firestore／Storage 規則與索引：

```powershell
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage --project YOUR_TEST_PROJECT
```

規則拒絕瀏覽器直接讀寫；所有私人存取走後端。Admin SDK 使用 IAM，不受前端規則代替保護，所以後端仍逐次檢查 UID／角色／關係。

在本機的環境設定 `APP_MODE=firebase`、`GOOGLE_CLOUD_PROJECT`、`STORAGE_BUCKET`，以部署帳號 ADC 執行：

```powershell
npm run import:catalog
npm run admin -- FIREBASE_UID
```

首位管理員先完成一般註冊，再從 Firebase Console 取得 UID；不要以 Email 推定 UID。授權後重新登入取得新 claims。一般帳號無管理員升級 API。管理員後台給指定測試者資格，最多 50 席。

官方仿單可由後台上傳，或在 Firebase 模式執行 `npm run import:leaflet -- PDF_PATH LICENSE_NO OFFICIAL_HTTPS_URL`。資料只進入草稿；核對後發布。不要把 `.local/db.json` 整份複製到正式 Firestore，其中可能混有測試帳號。

首次主檔手動匯入完成後，觀察 weekly job 是否能更新 `settings/catalog`。手動觸發 Scheduler 測試 OIDC；不以開放 worker 未驗證訪問作為修復方式。

## 預算、觀測與備份

`infra/budget.example.json` 提供 NT$500、50%／80%／100% 範例，**尚未建立實際預算**。在 Cloud Billing 預算中選定專案、確認帳戶計費幣別及通知收件人；若帳戶不使用 TWD，需換成實際計費幣別的目標。通知不是硬性停機或費用保證。

另有每日每人 20／全站 200 次 AI 任務建立上限，以及有限 worker 重試。所選 OpenAI／NVIDIA 帳號的額度與帳單另行查看；設定檢查不驗證額度。Cloud Run 縮到零仍可能有 Scheduler、Firestore、儲存、備份、映像及網路費用。

Cloud Logging 的應用錯誤只輸出 requestId、錯誤代碼、狀態碼及非敏感 I/O 錯誤碼；不輸出照片、金鑰、健康摘要或問答全文。建立 Cloud Run 5xx、worker 失敗、Scheduler 失敗及費用通知；通知接收者尚待設定。

Firestore 備份每日一次、保留 7 天。另建還原資料庫做演練：

```powershell
./infra/restore-drill.ps1 -ProjectId YOUR_TEST_PROJECT -BackupResource 'projects/PROJECT/locations/REGION/backups/BACKUP_ID' -DestinationDatabase 'restore-drill-20260910'
```

核對測試帳號資料筆數、匯出檔與照護關係，將備份來源、還原時間、核對結果記入驗收報告。腳本不會刪除演練資料庫。Firestore 備份不包含 Firebase Auth 與 Cloud Storage；官方 PDF 依雜湊保存並保留來源清單，正式啟用前另驗證其復原流程。

帳號刪除立即拒絕應用存取，背景工作清除健康資料／裝置／照護關係並刪除 Firebase user。失敗的清除工作在後台重試；备份中的舊資料依 7 天保留期到期。正式刪除完成前不可將任務誤標為成功。

## 發版與回復

正式發版前記錄目前 revision；先在測試專案跑完 `docs/VALIDATION.md` 的雲端驗收。部署腳本保留既有 revision，不刪除舊版本。需要回復時將正式服務流量導回指定的上一個 revision：

```powershell
gcloud run services update-traffic yzt-prod-web --project YOUR_PROD_PROJECT --region asia-east1 --to-revisions PREVIOUS_WEB_REVISION=100
gcloud run services update-traffic yzt-prod-worker --project YOUR_PROD_PROJECT --region asia-east1 --to-revisions PREVIOUS_WORKER_REVISION=100
```

回復應用不會自動回復 Firestore 內容；涉及資料格式改變時需先安排相容遷移與還原演練。正式發布、費用與真實帳號驗收本次尚未執行。
