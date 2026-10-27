# JCMIT 評估工具

這組工具直接呼叫正式版的 `recognize()`、目錄排序及 `grounded()`，在隔離的本機目錄保存結果，不建立雲端帳號、不修改服務資料庫、不部署。使用真實模型仍會產生 API 費用。它是技術評估工具，不代表已完成人類標註或臨床評估。

## 資料格式與答案狀態

Manifest 的 `schemaVersion` 為 1。`referenceStatus` 只能為 `ai_draft`、`human_reviewed` 或 `adjudicated`；AI 輔助的視讀與第二個 AI 檢查仍然是 `ai_draft`，不可因程式需要而改成人類已核對。

辨識案例包含固定 `bagId`、影像相對路徑、SHA-256、媒體格式及逐筆藥品答案；六個欄位為 `name`、`strength`、`dose`、`doseUnit`、`frequency`、`route`。每欄必須明示：

- `legible`：可判讀，提供 `value`；執行前列出可接受的 `alternatives`。
- `absent`：照片沒有印出，不得由藥名或目錄補入。
- `illegible`：遮蔽、模糊或欄位意義不足以可靠判定；逐案註明原因。

`expectedLicenseNo` 只供可確認產品身分的藥品使用。不確定的案例省略，不硬選候選。文字型每次用量可放 `dose`，與數值劑量分開保留。現版不計療程、給藥時間及完整原文 OCR 指標。

學習案例包含問題、固定來源 JSON 的路徑與 SHA-256、可選合成 `context`，以及 `sourceGroupId`。來源檔包含完整 `chunks`，不得把不同使用情境當作新的獨立來源。

案例的 `provenance`／`annotation`、頂層 `privacyScope` 需如實記錄來源、授權、遮蔽範圍及答案建立方式；頂層不接受 `provenance`／`annotation`。`deidentified: true` 是資料準備者的聲明，不是程式能驗證的保證；來源只做部分遮蔽時須說明殘留欄位，不能宣稱完整匿名。原始圖片與評估輸出預設留在 Git 忽略的 `.local/jcmit-evaluation/`。

## 執行順序

先用開發資料 dry-run：

```powershell
npm run evaluate:jcmit -- --manifest .local/jcmit-evaluation/data/development/pilot.json --mode vision --run-id pilot-vision --max-cases 3 --repeats 1 --max-requests 6 --max-estimated-usd 0.10 --allow-provisional
```

預設不呼叫 API。此範例的 `--allow-provisional` 明示接受 AI 草稿答案；核對資料及設定後，保留相同參數並加入 `--run-real-ai`，才會使用真實模型。學習流程改用 `--mode learning`。真實執行必須明確設定案例數、重複次數、HTTP 上限及美元估算上限。

本版價格保護固定支援 OpenAI 官方端點的 `gpt-6-luna`；其他模型或端點直接拒絕，以免套錯牌價。`.env` 沿用專案設定，不把金鑰放入 manifest、命令參數或報告。

每批保存在 `.local/jcmit-evaluation/<run-id>/`：

| 檔案 | 用途 |
| --- | --- |
| `plan.json` | 輸入與程式雜湊、模型設定、次數與費用估算規則 |
| `state.json` | 完整執行與 HTTP 帳本；恢復與統計的權威資料 |
| `<case>-repeat-<n>.json` | 單次結果、失敗、原始候選與正式發布內容 |
| `summary.json` | 執行概況；完成不等同科學評估合格 |

同一 run ID 重開會核對計畫雜湊，已開始的案例不自動重送。中斷後結果不明的案例保留為未知；不能藉新 run ID 抹去失敗。修改程式、輸入、答案或次數後應另開有紀錄的批次。

## 費用與失敗紀錄

每個 HTTP 請求在傳送前先持久化，再保存實際回傳模型、service tier、usage、耗時及錯誤。重試也是請求，不免費。usage 缺漏會停止後續付費請求；零 HTTP 的保護阻擋須與已送出的模型失敗分開解讀。

牌價依 [OpenAI Luna 模型頁](https://developers.openai.com/api/docs/models/gpt-6-luna) 於 2026-10-20 核對。保護與報告採較保守的長上下文標準費率：input/cache-write 最高 US$0.25／百萬、output US$0.75／百萬。這是已知 token 的估算，不是帳單或供應商強制消費上限；影像 token 預留也只是估算。缺少 cache-write 資料時，精確費用維持 `null`，不擅自當零。

## 產生報告及人工評核清單

```powershell
npm run evaluate:jcmit:report -- .local/jcmit-evaluation/reports/full .local/jcmit-evaluation/full-vision/state.json .local/jcmit-evaluation/full-learning/state.json
```

報告會拒絕重複觀察、同一藥袋跨開發／測試分組，以及 HTTP 帳本漏算或重複。小批 pilot 與完整重複批次如包含相同 case/repeat，不應合併成同一品質結果表；兩批費用另外加總。

- `report.json`：按執行條件與分組列首次、所有重複、各欄分母、漏列、多列、整袋結果、延遲、用量及保守費用。
- `human-review-queue.json`：候選與發布內容的說明、題目、引用及原文，提供待填的人類評核欄位；均以空值開始。
- `human-review-key.json`：評核項目與條件／執行的對照。正式人工評核時應由資料管理者分開保管，內容本身仍可能洩露生成方式，不能保證完全盲測。

引用字串包含、選項格式與來源主欄覆蓋都只是機械檢查。無人類評核時，語意支持、唯一正解、所有選項可判斷及解釋品質維持未評估。沒有題目不能記成題目品質 100%。`supported` 表示程式的內容狀態，不能代替完整網頁流程或學習成效。

同一模型生成的未驗證候選與正式發布結果並存，不額外花費生成另一份比較組。發布內容可能由原文或固定閱讀題補齊，需保留來源類型，不能把所有改善歸功於模型。

## 目前資料範圍

本輪建立 3 張歷史開發實拍及 2 張新增實拍的 AI 輔助答案，另沿用 8 份既有仿單並新增 4 份官方來源，共 12 份、36 個情境；實際完成、拒絕及缺漏另見[本輪結果](JCMIT-EVALUATION-RESULTS-2026-10-21.md)。來源索引記錄 20 筆照片查閱／候選及排除原因。公開原圖均未加入 Git。

2 張新圖是書田 Vimax 標籤與郭綜合 Procaterol 藥袋。它們不等於已完成人工標註的正式樣本；原先 30 張新增獨立實拍目標仍缺 28 張。本輪已依這兩案修正正式辨識邏輯，因此修正後的五圖批次全部列開發回歸，原始新增圖測試結果保持不變。舊圖、新圖、掃描、合成圖及重複執行均不得混成同一獨立樣本數。
