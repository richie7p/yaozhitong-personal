# 藥智通：技術稽核修復紀錄

更新日期：2026-10-04。本輪以 GitHub 預設分支與最新 npm advisory 核對 2026-10-03 的稽核報告。

## PDF 項目對照（第 35-36 頁）

| PDF 項目 | 優先級 | 本輪狀態 |
| --- | --- | --- |
| Firebase／Firestore／gRPC production 依賴公告 | P1 | 已修補依賴樹，本機測試通過；Firebase staging 的真實相容性待驗證 |
| 外部服務與健康 domain 尚未完成正式驗證 | P1 | NVIDIA 合成流程 smoke 已通過；Firebase staging、部署及藥師審閱仍待驗證 |
| 核心產品測試與分列測試範圍 | P2 | 已重跑 48 項產品／API／隔離及 provider mock 測試；測試與真實服務的邊界列於下方，完整覆蓋仍不作保證 |
| npm full-tree 的 brace-expansion 公告 | P2 | 已更新；npm 全樹掃描為零項 |
| 可重現品質門檻 | P3 | CI 新增 Windows、production build 及依賴掃描；現有專案未配置 lint，維持型別、測試與建置檢查 |

PDF 的重複依賴／測試 finding 合併追蹤。Starlette 不適用本專案；本輪依實際 Node/Firebase 技術棧修補。

## 已完成的修改

| 項目 | 修改 | 驗證方式 |
| --- | --- | --- |
| Firebase／Google Cloud 依賴 | 將所有 `@grpc/grpc-js` 路徑統一為修補版本 1.14.5，保留 Firebase SDK 的現有版本 | 依賴樹、npm audit、型別檢查與應用測試 |
| brace-expansion | 更新鎖定版本至 2.1.7 | npm audit |
| CI 平台 | 在 Ubuntu、Windows 跑同一套檢查；新增 production build 與 npm audit | PR 的 Actions 結果 |
| CI 權限與產物 | workflow 僅需 contents read；各作業系統採不同瀏覽器結果產物名稱 | workflow 設定與執行結果 |

gRPC 由前端 Firebase 的傳遞依賴、Firebase Admin 的 Firestore 與 Google Cloud Tasks 使用。npm 曾建議降級 Firebase 至 9.14.0；本輪以同一個 gRPC major 的修補版本替換傳遞依賴，避免退回舊版 Firebase。override 應在上游依賴本身採用修補版本後重新評估移除。

## 重跑驗證

```powershell
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run check:lifecycle
npm audit --audit-level=moderate
npm audit --omit=dev
```

本機與 E2E 使用隔離合成資料，測試伺服器清空 NVIDIA Key。`check:lifecycle` 驗證真實本機服務重啟、舊 Token 失效、任務恢復與帳號資料刪除。它不代表 Firebase production、Cloud Tasks 或 NVIDIA 真實端點已驗證。

## 後續優先順序

1. 在隔離 Firebase staging 專案驗證登入、Firestore／Storage rules、Cloud Tasks 與 gRPC 升級後的實際讀寫及存取控制。
2. 真實 NVIDIA 小樣本流程已測（見下方紀錄）；持續擴充欄位缺漏、劑量原文與支持／否定資料集，需另做領域品質驗證。
3. 仿單保持既有草稿／發布狀態；目前 30 份中 2 份僅供本機軟體測試，仍需藥師審閱及正式發布驗收。
4. 完成備份／還原、帳號刪除與並行任務的正式環境演練。

本輪沒有改動醫療資料內容或將草稿發布，也沒有操作雲端 production 資料。npm 零項結果只代表當次掃描沒有已知公告命中。

## 修補依據

- [gRPC 憑證驗證公告](https://github.com/advisories/GHSA-m9gg-hp2v-232j)
- [brace-expansion 遞迴公告](https://github.com/advisories/GHSA-qhr7-859c-m2p7)

## 本輪本機驗證結果

2026-10-04，Windows／Node.js 22.23.2：48 項應用／API／provider mock 測試與 10 項桌機／手機 E2E 通過；型別檢查、production build、本機服務重啟／任務恢復／帳號刪除驗證通過。npm 全樹掃描由 5 項 high 降為零項。Ubuntu／Windows CI 結果見本 PR 的 Actions。

## 授權真實 API 後續測試

已補上 [NVIDIA 真實測試紀錄](LIVE-NVIDIA-TEST.md) 與可手動重跑的工具。詳列首次失敗、修正、最後一輪結果及驗證限制；不得由小樣本通過推論醫療或飼養正確率。

後續加強測試將應用／API／provider 測試增至 74 項、桌機／手機 E2E 增至 14 項，全部通過。補上辨識失敗資料清理、更換照片後的舊結果清理、空白頻次與數值表示回歸；真實圖片八例連續兩輪共 16/16 通過。上述 48／10 項為最初修補階段的歷史結果，最新驗證詳見真實測試紀錄與 PR。
