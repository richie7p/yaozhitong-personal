# 本機操作與驗收

2026-10-20：`AI_PROVIDER=openai` 與文字、藥袋影像及審核模型 `gpt-6-luna` 已啟用，[修正後固定五輪 5／5、15／15 任務與 25／25 HTTP 200 通過](../.local/reports/openai-luna-acceptance-20261020.json)，0 逾時／重試／備援；10 份說明包的 20 條說明、12 題、32 次引用通過兩份來源 QA。184／184 單元、32／32 模擬瀏覽器回歸、型別及建置通過，OpenAI v2 本機受控恢復 10／10 通過。8085 現展示 Luna 副本，服務重啟與保存介面 14／14 通過、0 新 AI；新副本尚未再次整機重開。範圍限兩份固定仿單與合成資料，詳細證據見[驗證紀錄](VALIDATION.md)，下方歷史不改寫。

準備檢查先 `npm run build`，再 `npm run check:openai:ready`；只做本機設定與建置檢查，0 次供應商呼叫，結果在 `.local/reports/openai-readiness.json`。可加 `-- --require-key` 要求金鑰存在，或 `-- --no-report` 只輸出。金鑰存在及啟用後仍分別為 `prepared_pending_activation`／`prepared_pending_real_acceptance`，這是準備工具狀態；真實完整驗收另由本次總表判定。新裝置須在金鑰設定、切換及重啟後另行實測。

2026-10-19 歷史紀錄：先用本機帳號與檔案資料庫，不需要 Google Cloud。真實 AI 仍需要所選供應商的金鑰、網路與有效 API 額度。最新 v9 的 118 項程式測試（12 個檔案）、30 項假的 AI 上游瀏覽器流程、正式建置及 10 項故障恢復檢查通過；NVIDIA GLM 文字／Omni 影像三輪真實完整流程為 2／3 成功，9 任務中 8 成功、1 逾時。5 份發布說明包的 11 條說明、8 題通過獨立來源 QA；只涵蓋兩份固定來源與合成資料，不能推算長期可靠度。完整結果見 [驗收摘要](SEMINAR-ACCEPTANCE.md)，展示與備案見 [SEMINAR.md](SEMINAR.md)。

## 開啟網站

首次在專案目錄執行 `npm ci`、`npm run prepare:local:demo`，再執行 `npm run build`、`npm start`，開啟 http://127.0.0.1:8080 。程式需持續執行；資料存在 `.local/db.json` 與 `.local/blobs/`。重啟後資料保留，但登入憑證失效，重新選擇本機帳號即可。

目前研討會頁在 http://127.0.0.1:8085，雙擊 **`啟動研討會展示.cmd`**，使用獨立 `.local/seminar-demo-luna-20261020`。副本以 Luna 修正後第三批首輪成功驗收資料建立（4 條說明、3 題、7 次引用），僅另補入經版本／SHA 核對的完整官方主檔 66,509 筆。已預載**真實 Luna 模型**產生的說明、題目及既有答案；生成內容與任務保持原值，原始驗收目錄完全未改。準備紀錄見展示資料夾的 `demo-preparation.json`；啟動器會檢查兩份 PDF SHA、目前內容版本與指定資料路徑。合成圖片在該資料夾的 `synthetic-two-medication-bag.png`；再次辨識會呼叫真實 AI。五分鐘順序及保存／重答方式見 [SEMINAR.md](SEMINAR.md)。舊 NVIDIA ready 與 v7 目錄僅作歷史。

- **本機使用者**：自己的藥品、健康資料、提醒、藥箱與問答。
- **本機家人**：獨立空白帳號，接受邀請後才看得到授權紀錄。
- **本機管理員**：帳號資格、停用、仿單草稿發布、用量與失敗任務。

三個帳號是開發用身份，沒有真實 Google／Email 密碼註冊。正式登入、驗證信、FCM 推播仍須日後接 Firebase。現階段可測站內提醒，關閉程式後不會有背景鬧鐘。

先前 NVIDIA 設定為 `AI_PROVIDER=nvidia` 搭配 `NVIDIA_API_KEY`，文字與影像主模型為 SuperVL、備援均為 GLM，以下三批數字屬該歷史階段。`NVIDIA_TEXT_FALLBACK_MODELS`／`NVIDIA_VISION_FALLBACK_MODELS` 可依序設定最多兩款，留白關閉。每次生成／審核／辨識的模型嘗試共用 45 秒、最多 3 個 HTTP，任務共用 120 秒，本文讀取亦受期限約束；有備援時文字主模型最多 12 秒（`AI_TEXT_PRIMARY_TIMEOUT_MS`）、影像最多 22 秒（`AI_PRIMARY_TIMEOUT_MS`），僅逾時、429／5xx 或網路故障切換，任務逐次保存紀錄。前三批固定五輪完整操作分別 3／5、3／5、1／5，全部失敗保留；當時第三批 13 個已建立任務中 8 成功、5 逾時，另 2 份說明未建立。NVIDIA 即時服務仍未穩定；ready 保存結果的介面 14／14 通過，可標示預先完成後展示。目前已在 Git 忽略的本機 `.env` 設定 OpenAI 金鑰並啟用 `AI_PROVIDER=openai`，文字與影像均為 `gpt-6-luna`；預檢與一次最小連線通過，修正後固定五輪完整流程與兩份來源 QA 已通過。若另有 `AI_TEXT_MODEL`／`AI_VISION_MODEL`，它們優先於供應商預設，切換時一併檢查。完整設定見 [README](../README.md#ai-供應商與本機設定)，不自動跨供應商。

## 功能操作順序

下列是產品功能順序。本輪兩份固定來源已有真實理解流程通過；其他藥品沒有新版本合格題目時，不能把第 3 步列為完成。

1. 新增藥品 → 選擇照片，或搜尋藥名、手動建檔。
2. 核對候選、劑量、單位、頻次。空白欄位可存草稿；未確認不能建立提醒。
3. 我的藥品 → 仿單說明 → 閱讀用途、已確認用法與個人化注意事項 → 展開原文 → 逐題理解確認。答錯可回看解釋與引用後重答；小教室依藥名保存進度，重新登入後繼續。
4. 用藥問答 → 選藥 → 提問。失敗時輸入保留；帳號與設定的 AI 處理紀錄可用原輸入重試。
5. 排定提醒 → 自行輸入時間 → 今日總覽打卡；服藥紀錄可更正。
6. 家庭藥箱 → 新增存量與效期 → 編輯或標記已處理。
7. 家人照護 → 產生邀請碼 → 另一個瀏覽器以本機家人接受 → 查看唯讀紀錄 → 取消授權。
8. 帳號與設定 → 修改健康資料、匯出資料；刪除帳號會清除該本機身份的資料，不能靠重新登入恢復。

## 官方仿單的本機範圍

本輪 `prepare:local:demo` 匯入 66,509 筆主檔及以下 2 份固定 PDF。儲存庫另有 30 份來源收集索引，不代表目前工作區已下載全部 PDF。這 2 份沿用既有 Codex 逐頁視覺與文字核對，供軟體流程測試；這不是藥師審核，也不是臨床安全性認證：

| 搜尋名稱 | 許可證               |
| -------- | -------------------- |
| 酵素膠囊 | 內衛成製字第000544號 |
| 咳服     | 衛署藥製字第026087號 |

審查範圍與固定版本記錄在 `data/leaflets/local-reviewed.json`。`npm run prepare:local:demo` 下載並核對固定原始檔，只在本機發布這兩個指定版本；已有完整來源資料的工作區也可沿用 `npm run prepare:local:leaflets`。兩者不會發布全部草稿，也不能用於 Firebase 環境；來源 hash 或版本變更會停止，須重新核對。

索引中另外 28 份尚待審核，不能宣稱已交付 30–50 份完整資料。蘇打錠的現行主檔與舊 PDF 品牌名稱不同，保留待確認。

## 自動驗收

```powershell
npm run check:local
```

執行後端／權限／資料隔離／檔案並行測試、桌面與手機尺寸瀏覽器流程、真實程式重啟及帳號刪除。每輪在獨立目錄測試，不改動本機使用者資料，不呼叫付費 AI。最新 build 與 30 項瀏覽器結果存於 `.local/reports/seminar-v9-regression.json`，明確標記假的 AI 上游。額外的 `npm run check:seminar:recovery` 檢查原任務重試、強制中止、未到期租約及冷啟動；真正整機重開另由 `重開機後驗收.cmd` 核對 Windows boot ID，不混同程序重啟。

模型實測另行明確執行，會消耗額度：

```powershell
npm run check:vision
npm run check:local:ai
npm run check:learning:ai
npm run check:seminar:flow
```

影像測試為 7 張另外建立的合成開發圖片，沒有動用保留測試集。歷史 `check:local:ai`／`check:learning:ai` 以 NVIDIA 為驗收對象，使用隔離本機服務、固定仿單與虛構患者；`check:local:ai` 使用目前 `dist/` 產物，修改程式後先建置。新的 `check:seminar:flow` 依 `AI_PROVIDER` 連向官方 NVIDIA／OpenAI HTTPS 端點，執行合成雙藥袋辨識、逐筆核對、兩份衛教及有合格題目時的桌面／手機理解流程；它會呼叫真實模型並消耗額度，不是一般回歸。

`check:learning:ai` 是歷史五任務驗收：一次辨識、兩份仿單衛教及各一則有來源問答，另測不呼叫模型的資料不足分支；結果保存在 `.local/reports/personal-learning-real-ai.json`。最新 v9 真實三輪 2／3 完整通過；[首輪完整報告](../.local/seminar-flow-1792420222698-c4d75065/report.json)及第 3 輪各完成 16／16 操作，包括辨識核對續接、桌面／375px 的錯題原文、答對、重整／重新登入保存與鍵盤檢查。第 2 輪酵素逾時，保留失敗，沒有另建任務補跑取代；缺 usage 時用量未知，不能解讀成零。OpenAI 未配置／未實測；真實照片、更多來源、保留集評估、實機 Android 與長時間運行尚未驗證。這是軟體與來源自測，不安排藥師簽核，也不當作臨床驗證。各輪結果與歷史失敗見 [VALIDATION.md](VALIDATION.md)。
