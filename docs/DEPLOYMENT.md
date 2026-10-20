# Google Cloud 與 Firebase 部署

2026-10-20 已完成 `asia-east1` 的 Google Cloud TEST 首次部署，並以真實 Firebase 登入、雲端資料庫／佇列及 OpenAI API 跑通固定合成藥袋流程。目前是受控測試環境，尚未完成大眾公開使用所需的全部驗收。

## 目前狀態（2026-10-20）

雲端與本機使用同一套介面，文字／影像均採 OpenAI `gpt-6-luna`、思考設定 `none`。Web 與 worker 使用同一組供應商、模型及對應 Secret，不自動跨供應商備援。現行映像為 `20261020-hosting-auth`，worker／web 各有100%流量指向本次修正 revision，兩者的 `APP_URL` 都使用[同網域 Hosting TEST 入口](https://project-b6fe4904-e687-4365-b2f.firebaseapp.com)。首次兩個AI任務的 `20261020-first-test` 及上一個登入修正版 `20261020-google-auth` 均保留為歷史基準；各映像的固定 digest 與各自驗收結果見[可攜驗收摘要](acceptance/cloud-first-deploy-20261020.json)。

已完成的固定雲端範圍：

- Firebase Email／密碼、Google provider、授權網域、明確帳號連結策略與 Web Push VAPID 已設定。實際驗收採兩個合成帳號的 Firebase Email／密碼登入；僅其中一個透過應用管理流程取得 AI 測試資格，暫時管理員 claim 隨即移除。
- 從官方來源匯入 **66,511筆**藥品主檔，獨立重下載並核對咳服錠 `衛署藥製字第026087號` 官方 PDF，發布 **1份**完整頁來源。`checkedBy=codex-source-verification` 表示來源逐字核對，不表示醫事審核。本機八藥示範資料庫沒有搬到雲端。
- 同一張無個資合成藥袋辨識兩款藥，保存咳服錠後產生4條說明與4題測驗；副作用、注意事項、警語三個完整欄位均核對 claim、引用及測驗對應。兩輪 API 各 **8／8** 通過，涵蓋重送、不同內容重複保存的409拒絕、跨帳號存取拒絕、答錯再答對及重新登入保存。
- 第一輪建立 **2個 AI 任務**，合計 **3次實際 OpenAI HTTP 呼叫**（影像、生成、核對）；無重試，任務處理時間分別約10.2秒與8.1秒。第二輪使用相同狀態與冪等鍵，沿用原任務，沒有新增模型呼叫。這不是兩次全新影像／模型推論，也不是長期可用性測試。
- Google登入修正版部署後，再以相同合成帳號、資料及冪等鍵重送第三輪 **8／8** 通過，仍只有原來兩個任務，沒有新增模型呼叫；另有 **5／5登入安全檢查**通過，核對合成帳號登入、匿名存取拒絕、無效Google憑證拒絕、客戶端指定UID拒絕及Firebase帳號未被改動。
- Chrome 另實際登入合成帳號，核對已保存藥品、三欄完整安全文字及4題，實際答錯再答對並保存。合成帳號由管理工具設定 `emailVerified:true`，因此**尚未驗證真實信件寄送、收信與點擊驗證**。

首次建置曾因 builder 缺少建置 bucket metadata 讀取權限而停止，補上該 bucket 的 Bucket Viewer 後建置／部署成功；權限修正的部署離線回歸 **43／43** 通過。535項程式測試、54項桌面／手機及39項部署檢查是先前本機提醒優化的歷史結果，不能當成本次雲端測試計數。

Google provider 的 Email scope／資料補齊與登出再登入修正，已完成本機 **564／564程式測試（37檔，包含29項專項）、54／54桌面／手機流程、正式建置及生命週期檢查**。新增公開 OAuth client ID 部署預檢後，PowerShell 7與Windows PowerShell 5.1依序執行均 **46／46** 通過。最初並行跑兩種 shell 時，共用暫存檔掃描把另一程序尚未移除的檔案當成殘留；依序重跑通過，未發現實際金鑰外洩。修正映像已部署並完成雲端重送、設定及拒絕案例核對；Chrome另完成合成帳號密碼登入、學習4／4保存、登出後同頁再次登入及首頁1筆藥品保留。

同網域 Hosting 版本已補 service worker 的 Firebase 保留路徑排除，本機程式測試 **578／578** 通過，包含新增14項 service worker 測試；完整部署 **74／74**、Hosting helper **17／17**離線回歸，在PowerShell 7與Windows PowerShell 5.1依序執行均通過。完整部署檢查另確認模擬CLI在測試後確實移除，以及真實模式缺CLI時會停止。這些程式與模擬 CLI 結果不取代雲端驗收，也不把前述54項瀏覽器結果當作新版本重新執行。

Hosting 已實際發布純rewrite設定、0個靜態檔案；`20261020-hosting-auth` 的入口檢查於11:31:25Z完成 **18／18**：首頁／健康／設定可達、同網域Firebase helper與service worker邊界正確、合成帳號密碼登入及Bearer／POST轉送、私人回覆 `no-store` 且匿名不會取得已登入快取、原1筆藥品與4題測驗可讀。任務仍為原2筆，沒有新增模型呼叫。這是Hosting入口驗收，尚不包含真實Google popup成功callback、實機推播或長時間冷啟動測試。

先前直接Cloud Run入口的真實 Google popup 已到達帳號選擇頁，要求的scope包含 `openid`、`profile`、`email`，但應用顯示 `auth/popup-closed-by-user`，當時後端未出現Google provider帳號。唯讀檢查確認Google provider已啟用、client ID相符且有client secret，HTTP為 `Cross-Origin-Opener-Policy: same-origin-allow-popups`、沒有COEP，檢查時console無錯誤輸出。改用Hosting後，先觀察到 `about:blank` 彈窗；後續確認callback已載入且彈窗自動關閉，主頁仍回報 `auth/popup-closed-by-user`，沒有完成登入。**同網域Hosting本身未解決此問題**；同頁重新導向登入的修正與驗收進行中，不能把18項入口或90項基礎設施通過當作Google登入成功。實際擁有者帳號及管理員初始化也未完成。

最新 `20261020-hosting-auth` 映像部署後唯讀基礎設施檢查於11:33:18Z完成 **90／90**，涵蓋初次映像86項、上一個登入修正版的兩項Google OAuth audience及本次Web／worker的兩項公開入口設定。完整範圍包含 Cloud Run 公開／私有邊界、服務最少0／最多2、runtime／caller／builder直接 IAM、Secret 引用、儲存生命週期、Cloud Tasks／Scheduler 設定、四組 READY 索引、每日備份保留7天及已發布的拒絕直接存取規則。初次部署後另以已登入合成使用者 token 直接讀取自己的既有 Firestore 帳號文件，得到預期 **403 `PERMISSION_DENIED`**；此個別探測沒有算成90項的一部分。各映像的86／88／90項結果分開保存，唯讀檢查沒有新增 AI 或改動雲端資源；組織／資料夾繼承 IAM 不在這次檢查範圍。

Scheduler 每分鐘檢查已有成功執行紀錄；每週主檔更新排程已啟用且目標／OIDC 正確，但尚未到首次執行時間，因此不列為排程執行成功。備份是設定核對，尚未執行還原。下方保留可重現的環境準備、離線檢查與部署指令；真實 OAuth、裝置通知與故障復原等剩餘範圍如下。

## 後續公開使用的驗收目標

後續目標是讓一般使用者以拍照或上傳圖片完成辨識、核對、仿單說明與理解測驗。上雲先採小範圍受邀測試，完成下列項目後再評估全面開放：

- 先完成實際擁有者帳號登入與管理員初始化，解決Google popup成功callback尚未確認的問題；再以真實使用者驗收註冊、驗證信、密碼重設、重新登入與兩裝置，另驗收撤銷照護、資料匯出及刪除。合成帳號已通過兩帳號應用隔離及密碼登出再登入，這不替代上述完整帳號生命週期。
- 在雲端實際注入建立回應遺失、排入佇列失敗、輪詢斷線、程序中止及重新啟動；確認同一次操作只建立一個任務並計次一次。本次重送相同請求已通過，尚未注入這些故障。
- 以實際手機驗收相機／圖片選取、不同光線、說明及測驗保存，並另驗收前背景推播；沒有官方來源時明示資料不足。
- 擴大雲端已核對官方仿單與藥品的覆蓋；本次僅一款藥完成說明／測驗驗收，66,511筆主檔不等於每筆都有可發布仿單。
- 完成備份及還原演練、錯誤告警與通知送達、預期同時使用人數的負載驗收、較長時間費用／穩定性觀測，以及公開版資料使用與刪除說明。

目前雲端新帳號不會自動取得 AI 資格，管理員最多核准 50 個有效測試名額；每日預設每人 20、全站 200 次 AI 任務。這些是受邀測試限制，不是公開服務容量或費用上限。全面開放時需另外決定資格、使用額度及濫用防護，不能只把網站網址公開就視為完成。

## 環境準備

1. 先使用獨立 Google Cloud／Firebase 測試專案；正式環境日後另外建立，避免現在多維護一套資源。確認已連結可用的試用計費帳戶及資料地區 `asia-east1`。現有 Google Cloud 專案須先透過 Firebase Console 加入 Firebase；只啟用 Firebase API 並不會完成此步驟。保留免費試用狀態，不因部署自行升級付費帳戶。
2. 安裝 Google Cloud CLI，登入部署帳號；本機匯入工具用 Application Default Credentials：`gcloud auth application-default login`。不要下載長期服務帳戶金鑰進專案。部署帳號須有建立資源、設定 IAM 及對所用服務帳戶的 `iam.serviceAccounts.actAs` 權限；專案 Owner 通常已具備。腳本不會為部署者自動增加角色。
3. Firebase Console 建立 Web App，將公開 config 另存 JSON 檔（包括 apiKey、authDomain、projectId、storageBucket、messagingSenderId、appId）。這不是 Admin SDK 私鑰。
4. Authentication 啟用 Google 和 Email／密碼。從 Google provider 的 **Web SDK configuration → Web client ID** 取得該專案的公開 OAuth client ID（形如 `123456789012-your-web-client.apps.googleusercontent.com`）。部署以 `-GoogleOAuthClientId` 傳入，或預先在目前程序設定 `GOOGLE_OAUTH_CLIENT_ID`；Web／worker 都會收到此設定。這是用來驗證 Google token audience 的公開識別碼，不是 Client secret，也不是 Firebase Web config 的 `apiKey`。不要把 Client secret 填入這個欄位。另設定驗證信、密碼重設樣板與授權網域。
5. 為落實「不只憑相同 Email 自動合併」，Authentication 的 User account linking 設為 **Create multiple accounts for each identity provider**。使用者須登入原帳號，從「帳號與設定」明確連結另一登入方式。若另一方式已屬於獨立 UID，介面回傳 Firebase 連結衝突，不會搬移健康資料；需保留原登入方式，不做隱性合併。此設定會影響供應商個人資料回傳，顯示名稱可在健康資料頁自行填寫。[官方設定說明](https://support.google.com/firebase/answer/9134820?hl=en)、[明確連結流程](https://firebase.google.com/docs/auth/web/account-linking)。
6. Cloud Messaging → Web Push certificates 產生公開 VAPID Key。
7. 先在目標專案建立／確認 `asia-east1` 的預設 Firestore 資料庫，部署下方四組索引並等待 READY，再更新服務。新資料庫也需要索引。
8. 若採用下方同網域 Hosting 入口，Firebase Web config 的 `authDomain` 須為 `PROJECT_ID.firebaseapp.com`。先核對既有 Hosting 網站用途及 live release，再發布轉送設定；Firebase CLI 需已登入有部署權限的帳號。入口驗收後，後續完整部署都帶入同一個 `-PublicAppUrl`。

Google 登入會明確要求 `email` scope；後端驗證 Google ID token 的簽章、指定 audience、issuer、時效及 `email_verified`，並要求其 `sub` 與目前登入 UID 的 Firebase Google provider 身分一致。只有該 UID 尚無信箱時才補入，不以 Email 尋找或合併另一 UID，也不取代或驗證既有密碼登入信箱。登入介面等資料補齊完成才進入主畫面，失敗會退出該次登入；登出後重新登入會重新設定 token provider。

維運限制：Firebase Admin 的 `getUser` 後接 `updateUser` 沒有原子式「信箱仍為空才寫入」條件；另一管理程序若在兩者之間替同一 UID 設定信箱，仍可能產生競態。補齊過程前已重新核對停用狀態及 provider 身分，維運時仍應避免同步進行該 UID 的信箱變更；本次不宣稱已驗證所有帳號管理併發情境。

第一次部署另使用專用 `yzt-<test|prod>-build` 服務帳戶，不依賴新專案的 Compute Engine 預設帳戶。此帳戶只有同地區建置暫存／日誌 bucket 的 Object Admin、Bucket Viewer，以及 `yaozhitong` 映像倉庫的 Writer；沒有應用資料 bucket、Firestore、Secret 或 Cloud Run 部署權限。Bucket Viewer 只綁在建置 bucket，提供 Cloud Build 前置驗證必要的 `storage.buckets.get`；Object Admin 只有物件操作，單獨授權會造成 `invalid bucket / does not have access to the bucket`。目前官方 Bucket Viewer 角色只有 `storage.buckets.get`、`storage.buckets.list`，不含修改 bucket 或 IAM 的權限。[Cloud Storage IAM 角色](https://docs.cloud.google.com/storage/docs/access-control/iam-roles)。來源及日誌明確放入使用者專案的建置 bucket，建置設定使用 `GCS_ONLY`，符合自訂建置帳戶不能使用 Google 擁有的預設日誌 bucket 的限制。[Cloud Build 官方設定](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)。

建置上傳前可在儲存庫根目錄執行 `gcloud meta list-files-for-upload` 核對來源清單；這只列出本機檔案。`.gcloudignore` 會沿用儲存庫 `.gitignore`，並明確排除 `.env`、`.local/`、`snapshot/`、`coverage/`、測試報告及工具／文件，避免本機截圖隨 Cloud Build 來源封存上傳。Docker 映像另以允許清單複製必要程式與前端資產。

## 提醒查詢索引與舊資料升級

本版改為資料庫端的到期查詢，必須先部署版本庫的索引：

```powershell
npx firebase-tools deploy --only firestore:indexes --project YOUR_TEST_PROJECT
gcloud firestore indexes composite list --database='(default)' --project YOUR_TEST_PROJECT
```

四組索引為 `schedules(active,nextAt)`、`schedules(active,nextFamilyAt)`、`notifications(status,leaseUntil)`、`jobs(status,leaseUntil)`，欄位均為升冪、集合範圍。等待四組狀態都是 READY；索引建立指令返回不一定代表已建好。`infra/deploy.ps1` 會在建立／確認資料庫後、建置映像與更新服務前檢查索引；缺少、仍在建立或讀取失敗會停止，保留舊服務。`-ValidateOnly` 仍只驗本機設定，不檢查真實雲端索引。

第一個背景檢查會為舊啟用中排程補上獨立家人檢查時間，保存 `settings/reminder-due-v1` 完成標記。升級租約五分鐘，當機可恢復；一般冷啟動只讀完成標記，不再全掃。大量既有排程需在測試環境驗證升級耗時及中斷接續，禁止為省事刪除真實使用者排程。

設定變更會交易式建立 `reminderRefresh` 待辦，背景只重新安排該使用者的排程，成功後刪除待辦；帳號刪除也會清除此資料。若回復到不理解新欄位的舊版本且仍持續寫入排程，再升回新版前需安排受控資料遷移，不能沿用已完成標記而忽略舊版新增的排程。

每分鐘仍有少量空查詢及升級標記讀取。合成的 50 人 × 3 個每日個人提醒量測為 12,028 次文件讀取／日，含裝置查詢；相較舊版僅排程讀取保守估算減少約 98.6%。這不是費用硬上限或雲端帳單實測，家人通知及其他流量應另量測。首次部署已建立四組 READY 索引；實際提醒量、交易重試、背景推播及帳單仍需觀測。

## 供應商、模型與金鑰

`infra/deploy.ps1` 保留原有參數，並加入供應商、模型與只驗設定模式：

| 參數 | 用途與預設 |
| --- | --- |
| `-ProjectId` | 必填；要部署的 Google Cloud／Firebase 專案 |
| `-FirebaseConfigPath` | 必填；Firebase Web 公開設定 JSON，內含的 `projectId` 必須相符 |
| `-GoogleOAuthClientId` | 同一 Firebase 專案 Google provider 的公開 Web client ID；未傳入時使用目前程序 `GOOGLE_OAUTH_CLIENT_ID`，兩者均缺少則停止 |
| `-PublicAppUrl` | 選填；提醒連結等使用的 HTTPS 公開 origin。採同網域 Hosting 時填 `https://PROJECT_ID.firebaseapp.com`，省略則沿用 Web Cloud Run URL；此參數不會發布 Hosting |
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

腳本**不會自動載入 `.env`**；模型覆寫與實際部署所需金鑰必須存在於執行腳本的程序環境。Google Web client ID 優先使用明確的 `-GoogleOAuthClientId`，否則讀取目前程序的 `GOOGLE_OAUTH_CLIENT_ID`；缺漏或不符合 Google Web client ID 格式會在任何雲端呼叫前停止，`-ValidateOnly` 也相同。格式檢查不能證明 ID 屬於目標專案，須從該 Firebase 專案的 Google provider 取得並核對。只要求所選 AI 供應商的金鑰；選 OpenAI 不要求 NVIDIA 金鑰，反之亦然。部署前先查看 `-ValidateOnly` 的解析結果，避免目前程序殘留的通用 `AI_*_MODEL` 蓋過專用設定。

本次只支援上述模型覆寫，不會將整份本機環境設定搬上雲端。部署明確沿用目前請求／影像主模型／文字主模型／任務的 45／22／12／120 秒期限，以及文字 2,400／影像 2,600 token 回覆上限；OpenAI 思考設定仍沿用應用程式的 `none`。供應商端點固定為官方 `https://api.openai.com/v1` 或 `https://integrate.api.nvidia.com/v1`，不採用終端中自訂的 `OPENAI_BASE_URL`／`NVIDIA_BASE_URL`。

實際部署時，金鑰只透過標準輸入上傳至對應 Secret Manager Secret，再提供給兩個後端服務；不放入部署參數、產生的環境設定檔、前端或日誌。首次雲端流程已成功使用後端 OpenAI Secret；設定與 IAM 另納入部署後核對。伺服器端金鑰管理方式見[OpenAI API 官方驗證說明](https://developers.openai.com/api/reference/overview)及[Cloud Run Secret 官方說明](https://docs.cloud.google.com/run/docs/configuring/services/secrets)。

## 只檢查設定，不部署

在儲存庫根目錄執行，先準備與測試專案相符的 Firebase Web 設定檔及 Google provider 公開 Web client ID；以下 ID 僅為格式範例，必須換成該專案的實際值：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -GoogleOAuthClientId '123456789012-your-web-client.apps.googleusercontent.com' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider openai -ValidateOnly
```

若要確認明確模型參數的優先順序：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -GoogleOAuthClientId '123456789012-your-web-client.apps.googleusercontent.com' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -AiProvider openai -TextModel gpt-6-luna -VisionModel gpt-6-luna -ValidateOnly
```

`-ValidateOnly` 可在沒有 Google Cloud CLI、沒有 AI 供應商金鑰的環境執行；仍需提供上述必要參數、Google Web client ID 與本機設定檔。它只驗證可在本機檢查的設定並輸出去敏 JSON，**不執行任何 `gcloud`、不建立資源、不上傳 Secret、不呼叫模型**，也不驗證 OAuth ID 實際歸屬、金鑰有效性、模型存取權／額度、計費或雲端權限。輸出 `googleOAuthClientConfigured:true` 只代表格式符合，不代表真實 Google 登入已驗收。

部署腳本另有完整離線回歸：

```powershell
./tools/check-deployment.ps1
```

這項回歸使用假金鑰與模擬 CLI，檢查模型解析、去敏設定、Secret 輸入及兩個服務的部署參數；不連雲端、不使用真正的 Google Cloud CLI 或金鑰，也不能代替實際雲端驗收。

## 執行或更新部署

以下指令會建立或更新雲端資源；2026-10-20 首次 TEST 已依此流程完成。其他環境或後續更新仍須先完成環境準備與設定檢查，再在部署程序環境安全設定所選供應商的金鑰；不要把金鑰文字寫進範例或命令歷史。

OpenAI 測試專案範例：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -GoogleOAuthClientId '123456789012-your-web-client.apps.googleusercontent.com' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider openai -TextModel gpt-6-luna -VisionModel gpt-6-luna
```

若日後明確選用 NVIDIA，先在目前程序環境設定 `NVIDIA_API_KEY`，再執行相同流程：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -GoogleOAuthClientId '123456789012-your-web-client.apps.googleusercontent.com' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider nvidia -TextModel 'nvidia/nemotron-3.5-super-vl-120b-a12b' -VisionModel 'nvidia/nemotron-3.5-super-vl-120b-a12b'
```

腳本建立／更新：

- Web Cloud Run：提供網站和 `/api/v1`，公開網路可達，私人 API 仍驗證 Firebase ID Token。
- Worker Cloud Run：Cloud Run IAM 私有，另外驗證 OIDC audience 和指定 service account email。
- Runtime／caller／build service accounts、Cloud Tasks、每分鐘到期檢查及每週日台北 03:00 主檔更新。
- 非公開 Cloud Storage、上傳區一天生命週期、所選供應商的 Secret、Firestore 每日備份保留 7 天。應用 bucket 關閉 soft delete，避免辨識完成後已刪除的照片再保留七天；官方主檔及仿單亦位於此 bucket，因此另保存官方來源與雜湊以供重建。
- 獨立且非公開的建置來源／日誌 bucket，七天生命週期並關閉 soft delete；不與使用者資料共用。建置失敗會停止，不更新 Cloud Run 服務；臨時建置設定檔在成功或失敗後都會移除。
- Cloud Run 最少 0、每個服務最多 2 個執行個體。Web 120 秒、worker 600 秒逾時。

兩個環境需使用不同 `ProjectId`；只改 `Environment` 名稱並不能隔離 Firebase Authentication 和預設 Firestore。

完成後，把實際使用的公開網域加入 Firebase Auth 授權網域。直接使用 Cloud Run 時加入其 Web 網域；採 Hosting 時依下方設定相同的 `authDomain` 與入口。使用 HTTPS；worker URL 不提供給瀏覽器。

## 同網域 Firebase Hosting 入口

此選項讓應用與 Firebase 登入輔助頁共用 `https://PROJECT_ID.firebaseapp.com`。入口須與 Firebase Web config 的 `authDomain` 一致，因此這個設定使用 `firebaseapp.com`，不改用另一個 `web.app` 網域。TEST已依下列流程完成發布及18項入口檢查；Google彈窗仍未成功登入，同頁重新導向修正須另驗收。

先把包含 service worker 修正的應用部署到既有 Web Cloud Run 並確認可用，再檢查目標 Firebase Hosting 網站的 live release：應為空網站或已屬於本應用。新的 Hosting release 會取代該網站原有設定；`-ValidateOnly` 不讀取雲端狀態，也不會替你檢查既有用途。

在儲存庫根目錄先檢查設定，再於確認目標網站後發布：

```powershell
./infra/deploy-hosting.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -Environment test -Region asia-east1 -ValidateOnly
./infra/deploy-hosting.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -Environment test -Region asia-east1
```

helper 固定使用 `firebase-tools@15.34.0`，真實發布需要 Node.js／npm 及已登入的 Firebase CLI。它在獨立暫存目錄產生設定與空的 `public` 目錄，僅發布 `hosting`：`**` rewrite 指向同地區的 `yzt-test-web`（正式環境為 `yzt-prod-web`）。不複製程式碼、`dist`、照片或本機資料，也不連帶發布 Firestore／Storage；網站和靜態資產仍由同一個 Cloud Run 映像提供。helper 不改動 `APP_URL`。

先驗證 Hosting 上的首頁、登入／登出、私人 API 拒絕與保存流程，再把它設為公開網址。之後每次完整部署都需帶入 `-PublicAppUrl`，避免重新部署把提醒連結改回直接 Cloud Run 網址；可先在相同指令末尾加 `-ValidateOnly`：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -GoogleOAuthClientId '123456789012-your-web-client.apps.googleusercontent.com' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -PublicAppUrl 'https://your-test-project.firebaseapp.com' -Environment test -Region asia-east1 -AiProvider openai -TextModel gpt-6-luna -VisionModel gpt-6-luna
```

`-PublicAppUrl` 只接受 HTTPS origin，不接受帳密、路徑、query 或 fragment；允許末尾 `/` 並正規化移除。格式錯誤會在任何雲端呼叫前停止，`-ValidateOnly` 也相同，輸出的 `publicAppUrl` 可核對解析結果。通過後，Web／worker 的 `APP_URL` 都使用它；worker 的內部 URL、Cloud Tasks／Scheduler 目標及 OIDC audience 維持原設定。省略此參數仍保留原有直接 Cloud Run 行為。

Firebase 保留 `/__` 與 `/__/...`（包括 OAuth handler／iframe）；service worker 對這些路徑不攔截、不快取，也不在失敗時回傳離線首頁。一般首頁與公開殼層仍保留既有離線行為，API／內部路徑維持排除。登入請求以 `Authorization: Bearer` 傳入 Firebase ID token，私人 API 回覆與前端 fetch 均採 `no-store`；Hosting 設定不得把私人 API 改為公開快取。動態內容的快取與 cookie 行為見[官方說明](https://firebase.google.com/docs/hosting/manage-cache)。

Hosting 對單一 HTTP 請求有 **60秒**逾時，設定 Cloud Run Web 120秒不能延長這個前端限制。本系統的 AI 流程先建立佇列任務，再以短請求輪詢結果，模型處理由私有 worker 執行，設計上不要求瀏覽器持有整個 AI 任務的 HTTP 連線；仍須在實際入口驗證冷啟動與輪詢接續。此入口不把 worker 對外公開。[官方 Cloud Run rewrite 與逾時說明](https://firebase.google.com/docs/hosting/cloud-run)。

## 規則、管理員與資料

部署 Firestore 規則與索引：

```powershell
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project YOUR_TEST_PROJECT
```

Firestore 規則拒絕瀏覽器直接讀寫；所有私人存取走後端。Admin SDK 使用 IAM，不受前端規則代替保護，所以後端仍逐次檢查 UID／角色／關係。

目前照片、主檔及仿單透過後端 Google Cloud Storage SDK 存取腳本建立的自訂 bucket，不使用 Firebase Storage 瀏覽器 SDK。此 bucket 以 uniform bucket-level access、public access prevention 及 runtime IAM 保護，不能以 `firebase deploy --only storage` 取代 IAM 驗證。`firebase.json` 未設定自訂 bucket 的 Firebase Storage target，直接部署 Storage 規則會指向 Firebase 預設 bucket，可能因尚未初始化而失敗；不要為這個指令另建不使用的預設 bucket。若日後改用 Firebase Storage，需先明確匯入及設定 target，再部署儲存庫的拒絕規則。[Firebase 部署目標說明](https://firebase.google.com/docs/cli/targets)。

在本機的環境設定 `APP_MODE=firebase`、`GOOGLE_CLOUD_PROJECT`、`STORAGE_BUCKET`，以部署帳號 ADC 執行：

```powershell
npm run import:catalog
npm run admin -- FIREBASE_UID
```

首位管理員先完成一般註冊，再從 Firebase Console 取得 UID；不要以 Email 推定 UID。授權後重新登入取得新 claims。一般帳號無管理員升級 API。管理員後台給指定測試者資格，最多 50 席。

官方仿單可由後台上傳，或在 Firebase 模式執行 `npm run import:leaflet -- PDF_PATH LICENSE_NO OFFICIAL_HTTPS_URL`。資料只進入草稿；核對後發布。不要把 `.local/db.json` 整份複製到正式 Firestore，其中可能混有測試帳號。

首次主檔手動匯入完成後，觀察 weekly job 是否能更新 `settings/catalog`。手動觸發 Scheduler 測試 OIDC；不以開放 worker 未驗證訪問作為修復方式。

## 預算、觀測與備份

本次已建立 TEST 的 **NT$500 費用提醒**，並設定 Cloud Run 最少0、每服務最多2個執行個體。`infra/budget.example.json` 保留可重用的50%／80%／100%門檻範例；其他專案須另確認計費幣別、範圍與通知對象。預算提醒不會自動停機，服務執行個體上限也不是整個專案的費用硬上限；尚未以真實超額費用觸發通知驗收。

若啟用 Firebase Hosting，其儲存與下載是另一項用量，不受 Cloud Run 的限制涵蓋。以2026-10-20官方說明，專案層級享有 **10GB Hosting儲存、每月10GB CDN至使用者下載**免額外費用額度；快取命中與未命中均計入下載量，超額依方案計費。純 rewrite 不另存一份網站資產，仍會有經 Hosting 送往使用者的流量；Cloud Run、Firestore及OpenAI費用也須各自計入。應在 Firebase Hosting Usage 另觀察用量，整專案NT$500預算提醒不是總帳單硬上限。[官方 Hosting 用量與定價](https://firebase.google.com/docs/hosting/usage-quotas-pricing)。

部署時仍保留 Google Cloud Free Trial；當時控制台顯示試用額度 **NT$9,534／90天**，此為當時顯示的試用條件，不是可承諾的即時餘額。Firebase 顯示 Blaze 是因專案連結既有 Free Trial 計費帳戶，沒有在本次將該計費帳戶升級為付費帳戶。官方說明指出，連結試用帳戶的 Firebase 專案會使用 Blaze；若未明確升級計費帳戶，不會因試用額度耗盡自動開始收取額外使用費，但服務可用性會受試用到期影響。[Firebase 試用與計費 FAQ](https://firebase.google.com/support/faq#pricing)。

官方供應商設定流程回傳 Authentication subtype 為 `IDENTITY_PLATFORM`，文件據實記錄，未把它當成另一次人工付費升級。以2026-10-20官方定價，Email／Google 等 Tier 1 登入前50,000個月活躍使用者（MAU）的認證費為零；這不包含其他雲端資源或 OpenAI 費用，也不代表所有認證方式皆免費。[Identity Platform 定價](https://cloud.google.com/identity-platform/pricing)。

另有每日每人 20／全站 200 次 AI 任務建立上限，以及有限 worker 重試。所選 OpenAI／NVIDIA 帳號的額度與帳單另行查看；設定檢查不驗證額度。Cloud Run 縮到零仍可能有 Scheduler、Firestore、儲存、備份、映像及網路費用。

實際回讀的兩個服務均採按請求計費、服務層級最多2；revision上限為3，受服務層級上限共同約束。啟動 CPU boost 目前為開啟，啟動及隨後短時間可能計入額外 CPU；每分鐘 Scheduler 也持續產生請求與資料庫操作。這次沒有用短時間成功測試推算整月費用。

Cloud Logging 的應用錯誤只輸出 requestId、錯誤代碼、狀態碼及非敏感 I/O 錯誤碼；不輸出照片、金鑰、健康摘要或問答全文。費用提醒已建立；Cloud Run 5xx、worker／Scheduler 失敗等運作告警與實際送達仍待驗收。

應用及建置 bucket 關閉 soft delete，否則 Cloud Storage 預設會把刪除物件額外保存七天並持續計費。關閉只影響新政策生效後刪除的物件，不會清除之前已 soft-delete 的副本；既有 bucket 更改此設定後，請先確認政策已生效再進行照片測試。[Cloud Storage 保留及計費說明](https://docs.cloud.google.com/storage/docs/soft-delete)。建置來源／日誌有七天生命週期，映像倉庫則仍保留各次版本，後續按實際用量安排清理。

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

回復應用不會自動回復 Firestore 內容；涉及資料格式改變時需先安排相容遷移與還原演練。本次已完成 TEST 首次部署與固定合成帳號流程，尚未完成正式公開發布、真實使用者身分／裝置、還原演練及長期費用驗收。
