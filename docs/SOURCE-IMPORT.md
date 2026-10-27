# 已核對官方仿單的來源限定匯入

`tools/import-reviewed-leaflets.ts` 只處理 manifest 明列的仿單、版本指標、附加稽核和原始來源物件。預設模式只在本機檢查，不載入 `.env`、應用程式 AI 模組或 Firebase。來源核對是官方身分、完整原文、頁面／HTML 文件和必要條件核對，不代表醫事人員審核。

2026-10-21 的私有 manifest 在 `.local/cloud-leaflet-readiness-20261021/manifest.json`。八份來源是 000544、014025、019054、026087、030418、039632、040161、040833；026087 預期已發布而不變更，另七份補入。manifest 每份都明列官方 URL、原始檔 SHA、完整文字 SHA、draft/review 檔 SHA 和核對範圍，不從任意資料庫推測或複製資料。

000544／026087 必須用已核對的完整頁面版本；展示資料庫仍有早期 1000 字切片。030418 是原 PDF 無可用文字層、經獨立核對的完整人工轉錄。014025／040833 是官方 HTML，`page=1` 表示完整邏輯文件；原始 HTML SHA 隨網站驗證 token 改變，所以另核對完整 canonical 文字 SHA。PDF-only 匯入及後台分段文字編輯不能重建這三份來源。

## 準備與檢查

準備檔案應保存在私有 `.local`，不得加入患者照片、帳號、學習紀錄或秘密。每個 `draftPath` 只可包含 `Leaflet` 的來源欄位，且 `status=draft`、`checkedBy=null`、`checkedAt=null`；每頁一個 `whole-page-v1` chunk。`reviewEvidencePath` 是另外保存的來源核對證據，不會冒用本機管理者身分發布。

```powershell
node --import tsx tools/import-reviewed-leaflets.ts --manifest .local/cloud-leaflet-readiness-20261021/manifest.json

python tools/verify-reviewed-leaflet-sources.py --manifest .local/cloud-leaflet-readiness-20261021/manifest.json --output .local/cloud-leaflet-readiness-20261021/official-live-verification-current.json
```

第二條指令只讀 TFDA HTTPS：重新取得完整 PDF／HTML，核對完整 canonical 文字，並重新取得 InfoId36／39 檢查有效許可證、名稱、劑型、製造商和仿單索引。它不輸出原始 HTML token，不做模型呼叫或雲端寫入。原始 PDF 改變、HTML 任何主段落改變、索引變動或檢查失敗時，應重新核對新來源，不沿用原審核或強制通過。

## 指定雲端目標並保存 before 快照

用 ADC 執行，明確傳入 project、bucket 和一個尚不存在的快照路徑。不要用 `.env` 包裝此指令。若環境已有相反的 project／bucket／APP_MODE 或 emulator，工具會拒絕。

```powershell
node --import tsx tools/import-reviewed-leaflets.ts --mode inspect --manifest .local/cloud-leaflet-readiness-20261021/manifest.json --verification .local/cloud-leaflet-readiness-20261021/official-live-verification-current.json --project PROJECT_ID --bucket BUCKET_NAME --snapshot .local/cloud-leaflet-readiness-20261021/before-import.json
```

`inspect` 不寫雲端。它核對目標 catalog 中的八個身分、現有來源、指標和 blob SHA；只把這些來源的 before 狀態保存在私有快照，不匯出其他 collection。已發布不同版本或現有來源內容有差異會阻擋，避免意外取代。有效的官方 live 檢查需在 24 小時內。

## 明確執行與回讀

```powershell
node --import tsx tools/import-reviewed-leaflets.ts --mode apply --manifest .local/cloud-leaflet-readiness-20261021/manifest.json --verification .local/cloud-leaflet-readiness-20261021/official-live-verification-current.json --project PROJECT_ID --bucket BUCKET_NAME --snapshot .local/cloud-leaflet-readiness-20261021/before-import.json
```

`apply` 要求相同 manifest、官方報告、目標和 actor。blob 只能以 generation=0 建立，既有物件須 hash 相同；不覆寫來源檔。每份來源在同一 Firestore 交易中比對 before 狀態、發布來源與版本指標、附加 `leaflet.publish` 及 `leaflet.source_verification.literal_not_clinical` 稽核。與正常發布相同的來源／審核欄位會保存；不同的現行版本一律不取代。同內容已發布是零寫入 no-op，保留原核對者。每份完成後重新核對指標、完整來源和 blob，並寫入快照旁的 `.journal.jsonl`。

來源和指標包含本次 `sourceImport` runId／manifest hash／時間戳。若程序在交易後、寫本機 journal 前中斷，使用同一快照重跑可辨識已完成的本次交易，不會冒用別次發布。工具不寫 users、profiles、jobs、usage、medications、schedules、generated、learning、doseLogs、notifications 或 settings。

## 撤回本次發布

```powershell
node --import tsx tools/import-reviewed-leaflets.ts --mode rollback --manifest .local/cloud-leaflet-readiness-20261021/manifest.json --project PROJECT_ID --bucket BUCKET_NAME --snapshot .local/cloud-leaflet-readiness-20261021/before-import.json
```

`rollback` 只撤回與本次 runId、manifest、核對者、發布時間、內容完全對應的指標。原本已發布的同內容來源保持原狀；原本已有草稿則恢復原草稿，新增來源則保留為 retired，blob 和全部稽核保留。遇到別人變更的來源會保留並回報衝突，繼續處理其餘確定屬於本次的來源，最後以非零狀態提醒核對。它不刪來源 blob，不改帳號或學習資料，不部署應用程式。

快照旁的 `.lock` 防止本機同一路徑重入；殘留鎖不會自動移除。先確認鎖內 PID 已結束，再移除該單一鎖檔。跨主機／後台競爭仍由 Firestore CAS 阻擋。

發布後另以既有上傳圖片流程確認各藥品選擇、來源引用、完整安全段落和學習內容；來源匯入本身不會複製展示題目，也不代表公開使用的所有驗收已完成。
