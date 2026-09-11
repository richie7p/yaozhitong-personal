# 藥智通 · 個人專題版

以團隊黑客松作品為流程參考，重新建立的 React／Hono 應用。提供藥袋辨識、官方藥品搜尋、人工確認、附來源問答、用藥提醒與紀錄、家庭藥箱及唯讀家人照護。

**目前交付的是可在本機操作、附雲端部署工具的開發版本。** 目前先完成本機驗收，不需要先註冊 Google Cloud。已收集 30 份官方仿單，其中 2 份經逐頁文字核對後供本機軟體測試，其餘 28 份保持草稿。尚未完成藥師審閱與正式環境驗收。未發布仿單的藥品會呈現資料不足。

先看 [本機操作與驗收指南](docs/LOCAL-TESTING.md)。

## 在其他裝置接續開發

在另一台電腦安裝 Git、Node.js 22.16 以上，下載專案：

```powershell
git clone https://github.com/richie7p/yaozhitong-personal.git
cd yaozhitong-personal
npm ci
cp .env.example .env
npm run dev
```

開啟 <http://127.0.0.1:5173>。需要 AI 功能時，在該裝置的 `.env` 填入自己的 `NVIDIA_API_KEY`。`.env`、本機帳號資料、藥袋照片及下載的 PDF 都不會隨 GitHub 同步；新裝置的本機資料從空白開始，官方資料匯入方式見 [資料說明](docs/DATA.md)。

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

## NVIDIA

後端讀取 `NVIDIA_API_KEY` 環境變數，或未追蹤的 `.env`。不要將金鑰加入前端設定、Git 或部署指令參數。

| 用途                 | 目前預設模型                                    |
| -------------------- | ----------------------------------------------- |
| 文字、問答、證據審核 | `nvidia/nemotron-3.5-lightning-30b-a3b`         |
| 藥袋影像             | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` |

原計畫的兩個模型端點在本次帳號實測回傳 410，因此換成可用模型。模型名稱與端點皆可用 `.env.example` 中的設定替換；不自動切換其他供應商。文字 JSON、七種合成藥袋情境與證據否定案例已實測，完整紀錄見 `docs/VALIDATION.md`。

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

主檔索引保存到本機檔案或 Cloud Storage，後端載入記憶體搜尋。此次匯入 **66,478 筆**。收集工具只產生仿單草稿，不會代替審核者發布。

登入本機管理員，前往管理後台 → 仿單資料；核對官方 PDF、許可證、頁碼、抽取文字與表格閱讀順序，必要時修正文字，再勾選確認並發布。源資料清單在 `data/leaflets/`，完整 PDF 在 `.local/blobs/leaflets/`。操作說明見 [仿單資料審核](docs/DATA.md)。

## 核心行為

- 每筆私人資料以後端驗證的 UID 歸屬，瀏覽器不能指定其他擁有者。管理員帳號清單、任務用量不包含健康問卷與問答內容。
- 藥袋缺漏保持空白；劑量與單位必須能在移除藥名、含量後的辨識原文中核對，否則清空。使用者確認後才能排提醒。需要時服用獨立提供手動記錄。此檢查不能取代人對照片的核對。
- 每條生成陳述先檢查段落歸屬與原文，再由 NVIDIA 做語意支持審核；不通過就移除。模型審核仍可能犯錯，不能把字串吻合或模型同意當成醫療正確率。
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
