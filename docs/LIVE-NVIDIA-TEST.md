# NVIDIA 真實 API 測試

## 加強測試與修正（2026-10-04）

辨識擴充測試重現空白欄位被回傳為「每次劑量：頻次：」、清楚合成藥袋被誤拒絕，以及數值被回成 JSON 字串的問題。已修正：

- 使用英文 OCR 指令及 JSON object 輸出模式，明確區分產品含量與每次劑量、排除欄位標題與免責標示；仍保留影像原文語言，不要求藥名是真實已知藥品。
- 只正規化明確的十進位數字字串與空白／`null` 文字，不解析分數、單位字串、科學記號或指令；數字仍須通過正值／整數驗證，每次劑量仍須與原文核對。
- 合併的空白頻次標題會被清空；模型回報 failed 時丟棄藥品列，空清單不能回報辨識成功。截斷或錯誤 JSON 回應轉為可重試錯誤。
- 更換照片或重新辨識會清除舊結果與編輯草稿；辨識失敗歷史顯示「未能辨識」及重新上傳入口。

修正後 74 項應用／API／provider 測試、14 項桌機／手機 E2E 及型別檢查通過。真實圖片開發案例連續兩輪 8/8，共 16/16 通過：清楚、模糊、偏暗、反光、缺劑量／頻次、不同含量、同圖兩種含量與非藥袋拒絕。相同八例重跑屬回歸，不是獨立保留測試集或真實藥袋準確率。

開發期間亦觀察到服務忙碌、逾時與輸出型別錯誤，不能由最後兩輪通過保證每次雲端呼叫都成功。保留有界重試、顯示失敗及人工確認機制。未採用測試中逾時的替代模型或推理模式。

可使用 `npx tsx tools/check-local-vision.ts` 重跑八張合成開發案例；每次會留下有時間戳記的報告。此工具不修改既有保留測試集。

模型設定依 [NVIDIA Omni API 文件](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning) 與實測核對；英文提示只用於服務請求，使用者畫面維持繁體中文。

以下表格保留前一輪五項流程測試的歷史結果；最新重測與 GitHub CI 結果見 PR 說明。

最終程式再跑五項真實 API 流程全部通過：JSON 連線、照片辨識任務、引用／測驗生成任務、不受支持結論的真實審核，以及自行停藥／改劑量要求的拒答。最後一輪耗時依序為 497、2788、9617、8354、1290 ms；這是流程時間，不是 SLA。

2026-10-04，Windows 本機，使用授權金鑰、合成資料與真實 NVIDIA hosted API。最後一輪 5 項流程檢查通過。小樣本不代表醫療／獸醫準確率、穩定性、成本或 production 驗收；自動 CI 仍使用 Fake Provider，不消耗真實額度。

## 重跑

完成 README 的依賴安裝，將 `NVIDIA_API_KEY` 放在未追蹤的 `.env` 或程序環境，再執行：

```powershell
npm.cmd run smoke:live
```

從 repository 根目錄執行。需安裝 Playwright Chromium（`npx.cmd playwright install chromium`），且 `APP_MODE=local`。預設遮蔽金鑰報告位於 `.local/reports/nvidia-live.json`。測試使用標準本機登入、實際 Hono API、記憶體 Store 與合成知識來源；不寫入 Firebase。藥袋圖片暫存於 `.local/live-vision-fixture.png`。

## 最後一輪實測

| 檢查 | 結果 | 當次耗時 |
| --- | --- | --- |
| `real_json_connection` | 通過 | 446 ms |
| `real_vision_api_job` | 通過 | 4746 ms |
| `real_grounded_bundle_api_job` | 通過 | 4395 ms |
| `real_unsupported_claim_verification` | 通過 | 921 ms |
| `real_refusal_boundary` | 通過 | 613 ms |

耗時為單次流程（可能含多個 NVIDIA 請求），不是統計延遲或 SLA。

## 首次失敗及限制

藥智通第一輪合成藥袋回傳辨識失敗；重測相同可讀圖片後，藥名、每次劑量、單位、頻次、途徑、天數 6 欄位全部吻合。保留既有失敗／人工確認流程，不能由重測成功推論辨識穩定性或準確率。

未受支持結論測試只有生成階段注入固定錯誤 claim，審核階段使用真實模型；bundle 的生成、引用與測驗審核皆使用真實模型。仿單在記憶體中的 published 狀態僅為合成 fixture，未發布真實醫療文件。

不代表完整實機部署或雲端 production 驗證；知識文件仍需資料負責人／藥師／獸醫審閱。金鑰未進入 repository、報告或 GitHub Actions；真實測試須手動啟動，會消耗帳戶可用額度。
