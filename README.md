# 藥智通 · 個人專題版

以團隊黑客松作品為流程參考，重新建立的 React／Hono 應用。提供藥袋辨識、官方藥品搜尋、使用者確認、附來源問答、用藥提醒與紀錄、家庭藥箱及唯讀家人照護。

**目前交付的是可在本機操作、附雲端部署工具的開發版本。** 本輪是研討會軟體流程與來源自測，不含臨床驗證，也不把藥師簽核列為展示前置。未發布或無法確認來源的藥品呈現資料不足。

**目前使用同一套「用藥手帳」介面**，以每日用藥清單為首頁、藥品檔案與閱讀目錄為主體。紙白、墨綠、陶土色、章節編號與細分隔線構成視覺；仿單採手冊式排版，保留完整警語、引用及真實測驗保存。日常與「研討會展示」都在同一個8085服務內，沒有另一套預覽版。展示模式將已保存結果分為辨識、說明、測驗三步，也能接續現場拍照。詳見 [介面與操作說明](docs/UI-UX-REDESIGN.md)。

2026-10-20 現行程式使用 **GPT-6 Luna（`gpt-6-luna`，推理設定 `none`）**，策略為 `grounded-v13-complete-safety-literal-recognition`。本輪範圍擴充為 **8 款藥、8 份官方仿單來源（6 PDF、2 HTML）**；8 份來源中的 **17 個可識別安全主欄**逐欄保留完整原文，並為每欄至少提供一個重點的理解題。這表示固定來源主欄的覆蓋，不是所有子項、臨床情境或個人適用性的驗證。沒有安全欄的來源不捏造警語。

息咳寧已改用許可證040833的現行官方共同仿單，完整保留兩種口味的賦形劑分支，照片仍須由使用者核對候選，沒有推定口味。開恩達命採現行014025官方來源，保留新增的鈷過敏警語，不沿用舊版「可長期大量使用」之類敘述。HTML來源標示官方網頁與區塊，不冒充PDF頁碼。

辨識只從唯一明確原文補回模型原先留白的欄位；含量必須有可核對的數值與單位，純數字藥品代碼不當含量，不從目錄補入照片沒印的濃度。必要用法缺漏會保持留白並顯示固定核對提示；原文有明確矛盾才顯示具體衝突原因。這些檢查不取代使用者對照照片確認。

公開實拍樣本由2張增加為 **4張**，本次新增Kentamin醫院新聞照片與MND期刊藥袋照片。MND只作不完整用法的安全攔截案例，紅字完整讀取尚未通過，不列為完整辨識、仿單及測驗成功。歷史人物欄位不當測試病人資料；未驗收本人手機的新照片與各種光線／角度，HEIC仍不支援。Bubdel影像仿單仍靠經核對的人工轉錄，不能宣稱通用OCR已解決。

**v13已完成固定範圍驗收並採用：445／445單元、36／36桌面／手機回歸、受控恢復10／10、型別、建置及生命週期檢查通過。** 8085目前使用 `.local/seminar-demo-expanded-v13-20261020`，含8藥、8份學習、25題、12個任務、8份生成紀錄及4筆辨識。25條說明／25題另經第二角色來源QA；[服務重啟保存介面58／58](.local/seminar-demo-expanded-v13-20261020/service-restart-ui-report.json)通過，0新AI。這是服務重啟；本輪沒有再整台電腦重開，真正Windows重開14／14僅屬先前六藥v11。

本輪依變更範圍分組重驗，採用19個完整流程（手動12、正常實拍6、原兩藥合成袋1），另2個MND安全攔截案例；共29個任務、49次HTTP全部200、0逾時／重試／備援，最慢任務約11.9秒。這些接受案例跨不同凍結建置，不能稱21次均在最終同一建置執行；先前失敗及各自分母完整保留。用途補齊逐字保留Bl／Bl2與後置條件，原18份已通過內容另經0新AI不變性核對。固定小樣本不保證現場網路或供應商長期可用性；詳見[本輪可攜驗收摘要](docs/acceptance/seminar-v13-20261020.json)與[完整範圍／失敗歷史](docs/SEMINAR-EXPANDED-20261020.md)。

雙擊 `啟動藥智通.cmd` 開啟 [日常首頁](http://127.0.0.1:8085/#home)，再從選單進入 [研討會展示](http://127.0.0.1:8085/#demo)。此入口需要本機已準備好的指定資料，不會在新裝置自動還原，也沒有開機自動常駐。詳見[本輪擴充驗收與限制](docs/SEMINAR-EXPANDED-20261020.md)、[五分鐘展示與開場檢查](docs/SEMINAR.md)；[v11 GitHub驗收彙總](docs/acceptance/seminar-v11-20261020.json)及[較早歷史](docs/SEMINAR-ACCEPTANCE.md)保留原結果，日常操作見[本機指南](docs/LOCAL-TESTING.md)。

GitHub 僅保存程式、測試、文件及去除本機路徑與個別紀錄的彙總。文件中的 `.local/` 證據連結只在原驗收電腦可用；金鑰、本機帳號與藥品資料、照片、下載 PDF、原始測試報告及歷史 UI 截圖均不隨 Git 同步。新裝置需另設金鑰並準備資料；一般本機模式從空白資料開始。

Google Cloud 部署接法已準備，**尚未實際部署或驗收雲端可用性**。`infra/deploy.ps1` 新增 `-AiProvider openai`（預設）／`nvidia`、`-TextModel`、`-VisionModel` 與 `-ValidateOnly`，保留原有專案、Firebase Web 設定、VAPID、環境及地區參數。Web／worker 會使用相同供應商、模型與對應 Secret，失敗時不自動跨供應商備援。Firebase Auth、官方資料匯入、Cloud Tasks／Scheduler、通知及備份還原仍待雲端驗收，詳見 [部署設定與未完成驗收](docs/DEPLOYMENT.md)。

雲端模型解析順序為明確的 `-TextModel`／`-VisionModel` → 目前程序的 `AI_TEXT_MODEL`／`AI_VISION_MODEL` → 所選供應商專用環境變數 → 腳本預設值。OpenAI 預設文字與影像皆為 `gpt-6-luna`；NVIDIA 皆為 `nvidia/nemotron-3.5-super-vl-120b-a12b`。部署腳本不自動讀取 `.env`；實際部署只要求目前程序中所選供應商的 `OPENAI_API_KEY` 或 `NVIDIA_API_KEY`，透過標準輸入上傳至 `yzt-<test|prod>-<openai|nvidia>-key`，不放進指令參數或設定輸出。

先準備與測試專案相符的 Firebase Web 公開設定 JSON，再只檢查設定：

```powershell
./infra/deploy.ps1 -ProjectId 'your-test-project' -FirebaseConfigPath 'C:/private/firebase-test-web.json' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test -Region asia-east1 -AiProvider openai -ValidateOnly
```

`-ValidateOnly` 會在任何 `gcloud` 指令前輸出去敏 JSON 並返回，可無 Cloud CLI、可缺金鑰；不建立資源或呼叫模型，也不驗證模型存取權、額度與雲端權限。[日後實際部署範例與完整參數](docs/DEPLOYMENT.md)另列，這次沒有執行部署。

部署明確沿用目前的逾時、回覆長度與 OpenAI `none` 思考設定，端點固定為所選供應商的官方網址，不載入整份 `.env` 或終端自訂端點。`./tools/check-deployment.ps1` 提供全用假金鑰與模擬 CLI 的離線回歸，不連雲端或呼叫模型。

## 2026-10-20 可靠性修正

- 更換照片時立即清除前一張的辨識、核對草稿、保存提示與預覽；不支援或過大的新檔案不會留下可操作的舊結果，較早的照片驗證也不能覆蓋後選檔案。
- 同一帳號重送相同的未完成 AI 操作會沿用識別碼。建立回應遺失時重送原操作，已知任務的查詢中斷則接續查詢；確認成功或失敗後，下一次明確送出可建立新操作。瀏覽器允許工作階段儲存時可跨重新整理接續，照片需重新選取相同原檔；不在工作階段儲存照片、問題或健康文字，只保存雜湊及操作識別資訊。登出／切換帳號會清除前帳號的接續狀態。
- 家庭藥箱以台北日期判斷效期，頁面跨午夜及回到前景時會更新；有效日期當天維持保存中，已處理狀態優先。

本輪 **488／488 單元、54／54 桌面／手機流程、28／28 部署離線檢查，以及服務重啟／帳號刪除生命週期檢查通過**。兩種斷線接續情境另在桌面／手機各連測三次，共12／12通過。瀏覽器回歸涵蓋藥袋辨識、仿單說明、測驗保存及故障恢復，使用隔離合成資料與模擬 AI，沒有新增真實模型呼叫或雲端部署。原有八藥來源驗收範圍維持本文開頭所述；後續公開使用前的工作見[雲端公開使用驗收目標](docs/DEPLOYMENT.md#後續公開使用的驗收目標)。

## 在其他裝置接續開發

在另一台電腦安裝 Git、Node.js 22.16 以上，下載專案：

```powershell
git clone --branch master https://github.com/richie7p/yaozhitong-personal.git
cd yaozhitong-personal
npm ci
cp .env.example .env
npm run dev
```

開啟 <http://127.0.0.1:5173>。需要 AI 功能時，在該裝置的 `.env` 選擇供應商並填入對應金鑰，設定見下方。`.env`、本機帳號資料、藥袋照片及下載的 PDF 都不會隨 GitHub 同步；新裝置的本機資料從空白開始，官方資料匯入方式見 [資料說明](docs/DATA.md)。

每次開始修改前，在沒有未提交變更時執行 `git pull --ff-only`。修改完成後，把變更存成 commit 並推送：

```powershell
git add .
git commit -m "說明這次修改"
git push
```

推送需要登入有寫入權限的 GitHub 帳號（例如 `gh auth login`）。換裝置前先提交並推送；若拉取時提示衝突或分支分歧，先保留本機修改再處理，避免強制覆蓋。

新裝置要跑瀏覽器驗收，先執行 `npx playwright install chromium`，再執行 `npm run check:local`。目前驗收狀態見 [GitHub Actions](https://github.com/richie7p/yaozhitong-personal/actions)。

## 本機啟動

使用 Node.js 22.16 以上與 npm：

```powershell
npm ci
npm run dev
```

開啟 <http://127.0.0.1:5173>，可選「本機使用者」「本機家人」「本機管理員」。首次使用沒有健康示範資料。這三個身份只供開發；正式環境強制 Firebase 驗證，禁止本機登入。

本機資料在 `.local/`，不加入 Git。這個工作區位於 OneDrive，檔案可能受電腦同步設定影響；本機模式只使用測試資料。可用 `LOCAL_DATA_PATH` 指定其他儲存目錄。

單一服務預覽：

```powershell
npm run build
npm start
```

開啟 <http://127.0.0.1:8080>。開發模式需要程式保持執行才能檢查站內提醒；關閉程式後沒有背景通知服務。

## AI 供應商與本機設定

目前本機設定已切為 `AI_PROVIDER=openai`，文字與影像均使用 `gpt-6-luna`，金鑰僅由後端讀取 Git 忽略的 `.env`。下列模型設定不包含金鑰：

```dotenv
AI_PROVIDER=openai
OPENAI_TEXT_MODEL=gpt-6-luna
OPENAI_VISION_MODEL=gpt-6-luna
```

OpenAI API 金鑰只存入 `.env` 的 `OPENAI_API_KEY`。文字、影像與審核目標均為 `gpt-6-luna`；通用 `AI_TEXT_MODEL`、`AI_VISION_MODEL` 仍優先於 `OPENAI_TEXT_MODEL`、`OPENAI_VISION_MODEL`，本次啟用已通過舊模型覆寫預檢。只使用明確選擇的供應商，失敗時**不自動跨 NVIDIA／OpenAI 切換**。金鑰不放前端、Git、日誌或指令參數。

Luna 沿用 Chat Completions 接法，明確指定 `reasoning_effort=none`、`store=false`、`max_completion_tokens` 與 JSON 模式；藥袋欄位、來源、必要條件、唯一答案與測驗原文解釋檢查保持。呼叫 45 秒／任務 120 秒期限不放寬。官方能力與參數見 [GPT-6 Luna 模型頁](https://developers.openai.com/api/docs/models/gpt-6-luna)及[GPT-6 使用指南](https://developers.openai.com/api/docs/guides/latest-model)。先前兩藥 v9 階段先通過[最小連線](.local/reports/openai-connection.json)，再完成固定五輪真實流程及來源驗收；現行 v13 擴充狀態見本文開頭，各階段證據分開。

本機準備檢查：

```powershell
npm run build
npm run check:openai:ready
```

這項檢查只讀取模型設定、官方端點、`.env` 的 Git 忽略規則與建置版本，**0 次供應商呼叫**；結果寫入 `.local/reports/openai-readiness.json`。金鑰只記是否存在，不輸出內容，也不代表有效性已驗證。

| 準備狀態 | 意義 |
| --- | --- |
| `prepared_pending_key` | 接法與模型已備妥，等待金鑰 |
| `prepared_pending_activation` | 已有金鑰，尚未啟用 OpenAI |
| `prepared_pending_real_acceptance` | 已啟用，仍須真實模型與完整流程驗收 |
| `blocked_preparation` | 模型覆寫、端點或建置等本機設定需要修正 |

`npm run check:openai:ready -- --require-key` 在缺金鑰時回非零狀態；`--no-report` 只輸出結果，不寫報告。這些準備狀態皆不等於真實驗收通過；先前兩藥固定五輪、內容 QA 及恢復結果記於[歷史驗收摘要](docs/SEMINAR-ACCEPTANCE.md)，現行 v13 見[擴充驗收](docs/SEMINAR-EXPANDED-20261020.md)，不改寫準備工具的狀態定義。

OpenAI 帳戶額度／計費限制以 `ai_quota_exceeded` 結束，不重複重試；模型拒絕或內容過濾以 `ai_refused` 結束，不發布內容。暫時限流與 5xx 才在既有期限內重試，仍不切回 NVIDIA。JSON 模式的請求明確附上 JSON 輸出指令，原審核規則保持；OpenAI 快取政策為 `openai-chat-json-none-v2`，避免沿用修正前結果。

每次生成、審核或辨識呼叫的所有模型嘗試，共用預設 45 秒期限（`AI_REQUEST_TIMEOUT_MS`），每次最多 3 個 HTTP 請求；單一任務共用 120 秒整體期限（`AI_JOB_TIMEOUT_MS`）。有備援時，文字主模型最多等 12 秒（`AI_TEXT_PRIMARY_TIMEOUT_MS`），影像主模型最多等 22 秒（`AI_PRIMARY_TIMEOUT_MS`），均依剩餘時間縮短，將時間留給備援；讀取回應本文也受期限約束。生成另保留必要的審核時間。重試與換模型都不重設期限；同一任務已失敗的主模型不會在後續審核再等一次。

先前 NVIDIA 模型設定（歷史保存展示來源，未作 OpenAI 自動備援）：

| 用途 | 主模型 | 同 NVIDIA 備援 |
| --- | --- | --- |
| 文字、問答、證據審核 | `nvidia/nemotron-3.5-super-vl-120b-a12b` | `z-ai/glm-5.3-flash` |
| 藥袋影像 | `nvidia/nemotron-3.5-super-vl-120b-a12b` | `z-ai/glm-5.3-flash` |

主模型可用 `NVIDIA_TEXT_MODEL`、`NVIDIA_VISION_MODEL` 設定；備援順序如下，可用逗號分隔最多兩款，明確留白可關閉。程式預設備援清單為空，這份工作區及 `.env.example` 採下列設定；通用 `AI_TEXT_MODEL`、`AI_VISION_MODEL` 仍優先於供應商專屬主模型設定。

```dotenv
NVIDIA_TEXT_FALLBACK_MODELS=z-ai/glm-5.3-flash
NVIDIA_VISION_FALLBACK_MODELS=z-ai/glm-5.3-flash
AI_PRIMARY_TIMEOUT_MS=22000
AI_TEXT_PRIMARY_TIMEOUT_MS=12000
```

SuperVL 使用官方 `chat_template_kwargs.enable_thinking=false`；GLM 使用 `reasoning_effort=low`、`chat_template_kwargs.clear_thinking=true`。只在逾時、429／5xx 或網路故障時切換；金鑰權限、JSON／結構驗證失敗或內容截斷不會靠換模型掩蓋，也不會跨到 OpenAI。讀取回應本文時若已超過中止期限，亦明確歸為逾時。每次嘗試的模型、階段、延遲、狀態與用量存於任務 `aiRequests`；沒有 usage 時記為未知，不當零消耗。快取包含模型順序、12／22 秒設定、`nvidia-fallback-v2` 路由政策與 `literal-conditions-v1` 來源提及規則，變更設定不會誤沿用舊路由結果。

完整 v9 文字探測中，SuperVL 兩份來源均保留用途與測驗（18.360／8.223 秒）；GLM 酵素備援探測 5.160 秒通過。DiffusionGemma 兩來源逾時，Lightning 一次逾時、另一次沒有可發布測驗，失敗保留。這是選型探測，尚不等於五輪完整展示驗收；[選型報告](.local/reports/text-model-comparison-20261019-summary.json)與歷史三輪結果均保留。

GLM 影像候選以正式辨識提示、欄位驗證與完整 66,509 筆主檔，固定兩次探測均通過（6.214／6.395 秒，無重試或替換）。因此影像備援由 Omni 改為 GLM，維持主模型加一款備援；[原始探測](.local/seminar-vision-candidate-1792423328834/report.json)不等於完整流程通過。當時 NVIDIA 路由的[固定五輪](.local/seminar-stability-1792423389971-9fa17316/summary.json)仍僅 1／5 完整通過，不能因候選兩次成功便宣稱更換模型已解決服務可用性。先前兩批各自保留於驗收摘要；當時 OpenAI 尚無金鑰，2026-10-20 已啟用並另行驗收，結果不混算。

```powershell
npm run smoke:nvidia
npm run fixtures
npm run smoke:vision
npm run smoke:grounding
```

這些指令會呼叫 NVIDIA 並消耗帳號額度；回歸測試 `npm test`、`npm run test:e2e` 不會呼叫付費 AI。

## 官方資料與發布

```powershell
npm run import:catalog
npm run collect:leaflets -- 30
```

主檔索引保存到本機檔案或 Cloud Storage，後端載入記憶體搜尋。早期本機匯入快照為 **66,509 筆**；本輪指定展示副本的實際主檔筆數以最終準備報告為準。收集工具只產生仿單草稿，不會代替審核者發布。

登入本機管理員，前往管理後台 → 仿單資料；核對官方來源、許可證、PDF頁碼或HTML區塊、抽取文字與表格閱讀順序，必要時修正文字，再勾選確認並發布。源資料清單在 `data/leaflets/`，完整 PDF 在 `.local/blobs/leaflets/`。操作說明見 [仿單資料審核](docs/DATA.md)。

## 核心行為

- 每筆私人資料以後端驗證的 UID 歸屬，瀏覽器不能指定其他擁有者。管理員帳號清單、任務用量不包含健康問卷與問答內容。
- 藥袋缺漏保持空白；只有原模型為NULL且原文明確唯一的用量／頻次／途徑才可逐字補回，驗證時清空的不相符值不改填其他值。劑量與單位必須能在移除藥名、含量後的辨識原文中核對，否則清空。使用者確認後才能排提醒。需要時服用獨立提供手動記錄。此檢查不能取代人對照片的核對。
- 每條生成陳述先檢查段落歸屬與原文，再由所選供應商模型做語意支持審核；不通過就移除。模型審核仍可能犯錯，不能把字串吻合或模型同意當成醫療正確率。
- 已確認的警語與其原文都逐字提到所填健康狀況時，可標示「仿單原文提到…；請對照原文中的適用條件」。這與通過相關性審核的個人標籤分開，不推論症狀原因，也不恢復被審核拒絕的個人化標籤。
- 個人化快取包含 UID、健康資料版本、藥品版本、仿單版本、模型與提示版本。歷史回答保留當時來源，最新學習內容會排除已更新來源。
- 邀請碼一次使用、24 小時有效；家人只能查看授權藥品、排程與紀錄。新讀取即時檢查撤銷狀態，照護頁前景每 30 秒更新。
- Cloud Tasks 處理長任務；錯誤保留可重試輸入。辨識照片處理後刪除，重試辨識需重新上傳。帳號與設定頁提供 AI 處理紀錄。
- 推播只顯示通用提醒，未打卡顯示「尚未記錄」。PWA 只快取公開外殼，私人 API 不快取、不接受離線寫入。

## 開發與驗證

```powershell
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm audit --omit=dev
```

`src/` 是繁體中文手機優先介面；`shared/` 是共用型別与驗證；`server/` 是登入、資料與 AI；`tools/` 是資料匯入與評估；`infra/` 是 Google Cloud 部署、預算範例與還原演練指令。

- [部署與帳號設定](docs/DEPLOYMENT.md)
- [實作完成狀態與未完成驗收](docs/IMPLEMENTATION-STATUS.md)
- [測試、模型實测與評估限制](docs/VALIDATION.md)
- [API 與資料設計](docs/API.md)
- [原作與個人新增貢獻](docs/CONTRIBUTIONS.md)

## 來源與授權

原作：[Sean-Fang178/yaozhitong-web-demo](https://github.com/Sean-Fang178/yaozhitong-web-demo)，原連結 `find-med-web-demo` 已轉向新名稱。參考版本 `440850bc77e11419a98c1850beba5ac278d07233` 保留在 `reference/`，不納入新應用建置。

程式使用 Apache-2.0；見 `LICENSE`、`NOTICE`。TFDA 資料及官方仿單的權利與使用條款獨立於程式授權，保留官方來源網址和版本雜湊。
