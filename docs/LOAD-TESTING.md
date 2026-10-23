# 多人使用與負載測試

這組工具分別檢查正式後端在隔離環境的多人操作，以及實際部署的有限讀取負載。每日每人 20 次、全站 1,000 次的設定維持原值。

## 隔離的多人流程

需要 Node.js、Java 21 及 Firebase CLI。啟動官方 Authentication 與 Firestore emulator：

```powershell
firebase emulators:start --only "auth,firestore" --project demo-yzt-load-20261023 --config infra/load-emulators.example.json
```

在另一個終端執行：

```powershell
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:19099"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:18089"
$env:GOOGLE_CLOUD_PROJECT = "demo-yzt-load-20261023"
node --import tsx tools/run-load.ts --plan infra/load-emulator.example.json --out C:/yzt-private/load/emulator-result.json --catalog C:/yzt-private/catalog-readback.json
```

計畫只接受 `demo-` 專案及本機位址，兩個 emulator 位址也必須是本機。工具使用正式的 Firebase token 驗證、`FirestoreStore`、API 路由及 Domain；測試帳號、用藥與學習內容全部為合成資料，不寄信或呼叫付費模型。測試會建立 101 個隔離帳號：最多 100 個參與並發，另一個專門檢查個人額度邊界。

`--catalog` 指向既有官方公開目錄的完整讀回檔。工具驗證格式、記錄 SHA 與筆數，再加入一款合成產品；正式目錄查詢與產品身分索引會處理整份資料。省略時只使用一款合成產品，結果不能代表完整目錄的搜尋或記憶體負載。原始目錄及個人憑證不放入 Git。

預設以 20、50、100 個不同一般身分各完成 20 個請求，涵蓋用藥新增／修改／移除、提醒、保存的說明及問答、學習紀錄、私密回報列表與通知。也檢查另一人的用藥及工作無法讀寫、無效登入被拒絕、一般帳號無法進入管理端。完整目錄另測冷查詢、20／50 人重複查詢及不同查詢，分開記錄快取效果。

額度及恢復控制包含相同操作識別碼的 100 個並發請求、不同內容重用識別碼、已刪除佇列工作的恢復、重複 worker 派送、個人 19→20 與全站 999→1,000 邊界、20／50／100 人同時建立新工作，以及兩個後端實例各接收 50 個不同使用者的共享資料庫交易。這些邊界值只寫入隔離測試資料；正式專案不重設額度。

上傳測試使用沒有個資的合成 JPEG，依序讓 5、10、20 個身分各上傳 1～2 MB。它核對原始檔案雜湊、擁有者、工作保存、同操作重送、不同內容衝突及跨帳號拒絕；遇到明確忙碌回應時，以原識別碼有限重送，再核對只扣一次。這項測試不評估藥袋辨識品質。

## 實際雲端的有限讀取

`infra/load-cloud-read.example.json` 固定使用目前藥智通專案。預設只核對計畫；執行必須加上明確開關：

```powershell
node --import tsx tools/run-load.ts --plan infra/load-cloud-read.example.json --out C:/yzt-private/load/cloud-read.json
node --import tsx tools/run-load.ts --plan infra/load-cloud-read.example.json --out C:/yzt-private/load/cloud-read-executed.json --credentials C:/yzt-private/existing-synthetic-owner.json --execute-cloud-reads
```

私人憑證檔使用既有驗收狀態格式：專案 ID 與一個普通合成帳號的 UID、信箱及密碼。工具透過正常流程登入，核對帳號沒有管理員權限，再發出使用者自身資料的 GET；不新增帳號、不修改應用資料、不建立 AI 任務。正常登入可能更新 Firebase 的最後登入時間。

這個模式只允許 1／4／8 個虛擬用戶端，每階段最多 60 次、合計最多 180 次 API 讀取。它們共用一個既有帳號，因此只能反映部署環境的有限讀取負載。p95 超過 10 秒，或最近請求中的伺服器／傳輸失敗率超過 5%，即停止發出新請求。

## 結果判讀

輸出列出 p50、p95、p99、最大延遲、吞吐、HTTP 狀態、預期拒絕與真正錯誤，並按操作分組；不保存 token、密碼、回應本文或個人資料。每份輸出使用新檔名，附計畫 SHA、控制程式及本機後端的前後版本雜湊；執行途中程式變動會標記為未完成固定版本驗收。

Emulator 可重現 API、驗證與交易問題，但生產服務的交易競爭、索引、配額、擴展與延遲仍有差異。程序記憶體數字包含測試驅動與合成資料，不能直接作為 Cloud Run 容量。付費模型的真實排隊吞吐及大型公開流量，需另外以明確的帳號、工作與費用範圍測試。

官方環境說明：[安裝 Emulator Suite](https://firebase.google.com/docs/emulator-suite/install_and_configure)、[Firestore emulator 的範圍與限制](https://firebase.google.com/docs/emulator-suite/connect_firestore)。

## 2026-10-23 的結果

以完整 66,521 筆公開目錄與 101 個隔離帳號完成最終 v7 固定版本驗收。20／50／100 個不同身分共 3,400 次混合操作均符合預期，p95 分別約 292／462／784 毫秒。另以 100 個不同身分在單一後端及兩個後端各 50 人建立工作，均保存成功、額度正確。

AI 工作預留有不同的等待成本：包含大量同時預留及邊界控制的分布 p95 約 8.2 秒、最大約 10.1 秒。兩個刻意注入的派送失敗各回傳一次 503，均以同一操作識別碼恢復，只扣一次；這些不併入一般流程的零非預期錯誤。這項數據不包含模型生成與後續排隊時間。

最終 50 個不同、未快取的搜尋 p95 約 2.4 秒；20／50 人的重複查詢 p95 約 146／366 毫秒。照片前置排隊修正後，5／10／20 人各自上傳約 1.56 MB JPEG 均在第一個請求獲接受，沒有忙碌重送；20 人的 p95 約 3.3 秒。檔案原始 bytes、歸屬與重送扣次均已核對。

獨立覆核另發現匿名、尚未結束的分段上傳會在身分驗證前占住照片排隊名額，已改為先驗證登入、帳號狀態與信箱，再排隊及讀取圖片。本機控制確認匿名請求立即回傳 401，同時有效使用者可繼續操作；最終 v7 完整測試包含這項修正。

測試也保留未通過的 v6：兩個後端各允許兩個交易時，共用額度計數器發生競爭，100 個同時提交中有 40 個等候超過 20 秒，回傳可重試的 503；這 40 筆未扣額度。將每個後端的工作預留限制為一個交易後，兩次有界對照均為 100／100 成功，最終 v7 完整測試亦通過。等候上限仍是 20 秒，沒有放寬錯誤門檻。現在正式部署最多兩個網頁實例，因此同時最多兩筆預留交易；未來擴大實例數時須重新測量。

更新前的真實雲端基線完成 180 次 GET，1／4／8 個用戶端的 p95 約 2.56／2.52／2.68 秒，沒有非預期回應。這些用戶端共用同一個普通驗收帳號；更新後的同計畫重跑將另外記錄。詳見[本輪負載驗收](acceptance/public-load-20261023.json)。
