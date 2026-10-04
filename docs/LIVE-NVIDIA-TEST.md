# NVIDIA 真實 API 測試

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
