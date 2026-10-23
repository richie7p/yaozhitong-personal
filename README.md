# 藥智通 · 個人用藥手帳

藥智通協助使用者從藥袋照片建立用藥紀錄，閱讀有官方來源依據的白話說明、回答理解題，並管理服藥提醒及家人照護。

[開啟藥智通](https://project-b6fe4904-e687-4365-b2f.firebaseapp.com) · [公開使用與驗收狀態](docs/PUBLIC-READINESS.md) · [部署說明](docs/DEPLOYMENT.md)

## 使用流程

1. 註冊帳號並完成信箱驗證，或使用 Google 登入。
2. 上傳清楚的藥袋照片；逐項核對藥名、用量、單位、頻次與途徑，再保存。
3. 核對藥品身分後，開啟仿單說明或用藥問答，展開引用對照原文。
4. 回答理解題、查看解釋；答案與進度會保存，可再次複習。
5. 依已確認的用法設定提醒、記錄服藥，或授權家人查看唯讀紀錄。

雲端公開模式讓所有完成信箱驗證的帳號使用一般功能，不需另行申請試用名額。AI 新任務每日每人 **20 次**、全站 **1,000 次**，以台北日期計算；額滿時可繼續使用已保存資料、手動建檔及提醒。問題可透過站內私密回報表單送交管理員，回覆在回報頁查看。

照片支援 JPEG／PNG，單張 8 MB、3,200 萬畫素以內；HEIC 請先轉為 JPEG。上傳前遮住個資與識別條碼，移除照片中的位置等中繼資料。辨識結果需要使用者核對；缺少產品含量、劑型或許可證等關鍵資料時，系統會要求補拍或補資料。

## 官方來源與 AI 說明

目前雲端發布 **3,661 份官方仿單來源**。官方目錄與可用內容的涵蓋範圍不同，部分掃描圖、複雜版面或來源關聯仍待整理；可用數量及限制見 [仿單匯入紀錄](docs/TFDA-LEAFLET-INGESTION.md)。

白話說明、完整原文與測驗涵蓋範圍分開呈現。安全欄保留完整父條件、年齡、例外、跨頁文字與表格關係；白話內容及安全題會經模型輔助核對，每題只抽查一個重點。無法可靠整理的部分保留原文入口或顯示資料不足。來源更新後，過期學習內容須重新產生。

系統提供用藥資訊理解與紀錄，診斷、開藥、停藥及個人劑量決策仍須由醫療專業人員協助。網站的「資料使用與隱私」說明 AI 資料傳送、保存、匯出及刪除方式。

## 技術與維護

前端使用 React／TypeScript，後端使用 Hono。雲端採 Firebase Authentication、Firestore、Cloud Storage、Cloud Run 與 Cloud Tasks；背景工作處理 AI、提醒及帳號清理。AI 使用 OpenAI GPT-6 Luna，不自動跨供應商備援。部署範本採文字推理 `medium`、影像轉錄 `none`；已部署版本與實測結果見公開使用狀態。

AI 任務具有重送識別碼、交易式額度扣次、有限重試及結果版本檢查。維護工具包括[帳號與檔案備份還原](docs/BACKUP-RECOVERY.md)及[多人負載測試](docs/LOAD-TESTING.md)；現行部署與告警範圍詳見 [PUBLIC-READINESS](docs/PUBLIC-READINESS.md)。

## 本機啟動

需要 Node.js 22.16 以上與 npm；已有 `.env` 時請保留原檔。

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev
```

開啟 [本機開發頁](http://127.0.0.1:5173)，選擇本機測試身份。新環境從空白資料開始；雲端帳號與來源不會自動複製到本機。使用 AI 前，在後端 `.env` 設定自己的 `OPENAI_API_KEY`；金鑰、照片與本機資料不加入 Git。

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run check:lifecycle
```

PDF 來源驗證另需 [Python 相依套件](tools/requirements-tfda.txt)，可用 `TFDA_TEST_PYTHON` 指定直譯器。完整雲端驗收與程式回歸的版本、範圍及結果記錄在公開使用狀態文件；實際模型驗收與模擬 AI 的程式測試分開記錄。

## 專案貢獻

本專案延續原黑客松作品的產品流程，個人版本的重寫、來源處理與驗收範圍見 [CONTRIBUTIONS](docs/CONTRIBUTIONS.md)。

程式採 Apache-2.0，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。TFDA 資料及官方仿單依原來源條款使用，保留來源網址與版本。
