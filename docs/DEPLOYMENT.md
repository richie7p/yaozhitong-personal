# Google Cloud 與 Firebase 部署

此文件與腳本已完成本機語法／建置檢查，尚未在使用者的雲端帳號部署。需要有效的 Google Cloud 專案、計費帳號、Firebase Web 設定與 FCM Web Push 憑證。NVIDIA API 金鑰已可在目前環境實測，未写入儲存庫。

## 環境準備

1. 建立兩個獨立 Google Cloud／Firebase 專案，分別作為測試與正式環境。啟用計費，確認資料地區 `asia-east1` 符合專題需要。
2. 安裝 Google Cloud CLI，登入部署帳號；本機匯入工具用 Application Default Credentials：`gcloud auth application-default login`。不要下載長期服務帳戶金鑰進專案。
3. Firebase Console 建立 Web App，將公開 config 另存 JSON 檔（包括 apiKey、authDomain、projectId、storageBucket、messagingSenderId、appId）。這不是 Admin SDK 私鑰。
4. Authentication 啟用 Google 和 Email／密碼。設定驗證信、密碼重設樣板與授權網域。
5. 為落實「不只憑相同 Email 自動合併」，Authentication 的 User account linking 設為 **Create multiple accounts for each identity provider**。使用者須登入原帳號，從「帳號與設定」明確連結另一登入方式。若另一方式已屬於獨立 UID，介面回傳 Firebase 連結衝突，不會搬移健康資料；需保留原登入方式，不做隱性合併。此設定會影響供應商個人資料回傳，顯示名稱可在健康資料頁自行填寫。[官方設定說明](https://support.google.com/firebase/answer/9134820?hl=en)、[明確連結流程](https://firebase.google.com/docs/auth/web/account-linking)。
6. Cloud Messaging → Web Push certificates 產生公開 VAPID Key。

## 部署

在儲存庫根目錄執行；先使用測試專案：

```powershell
./infra/deploy.ps1 -ProjectId 'YOUR_TEST_PROJECT' -FirebaseConfigPath 'C:/private/firebase-web.json' -VapidKey 'YOUR_PUBLIC_VAPID_KEY' -Environment test
```

`NVIDIA_API_KEY` 必須事先存在目前程序環境；腳本透過標準輸入寫入 Secret Manager，不放在命令列參數或建置檔。設定檔可以參考 `.env.example`，不用寫入真正金鑰。

腳本建立／更新：

- Web Cloud Run：提供網站和 `/api/v1`，公開網路可達，私人 API 仍驗證 Firebase ID Token。
- Worker Cloud Run：Cloud Run IAM 私有，另外驗證 OIDC audience 和指定 service account email。
- Runtime／caller service accounts、Cloud Tasks、每分鐘到期檢查及每週日台北 03:00 主檔更新。
- 非公開 Cloud Storage、上傳區一天生命週期、NVIDIA Secret、Firestore 每日備份保留 7 天。
- Cloud Run 最少 0、每個服務最多 2 個執行個體。Web 120 秒、worker 600 秒逾時。

兩個環境需使用不同 `ProjectId`；只改 `Environment` 名稱並不能隔離 Firebase Authentication 和預設 Firestore。

完成後，把輸出的 Web Cloud Run 網域加入 Firebase Auth 授權網域。使用 HTTPS；worker URL 不提供給瀏覽器。

## 規則、管理員與資料

部署 Firestore／Storage 規則與索引：

```powershell
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage --project YOUR_TEST_PROJECT
```

規則拒絕瀏覽器直接讀寫；所有私人存取走後端。Admin SDK 使用 IAM，不受前端規則代替保護，所以後端仍逐次檢查 UID／角色／關係。

在本機的環境設定 `APP_MODE=firebase`、`GOOGLE_CLOUD_PROJECT`、`STORAGE_BUCKET`，以部署帳號 ADC 執行：

```powershell
npm run import:catalog
npm run admin -- FIREBASE_UID
```

首位管理員先完成一般註冊，再從 Firebase Console 取得 UID；不要以 Email 推定 UID。授權後重新登入取得新 claims。一般帳號無管理員升級 API。管理員後台給指定測試者資格，最多 50 席。

官方仿單可由後台上傳，或在 Firebase 模式執行 `npm run import:leaflet -- PDF_PATH LICENSE_NO OFFICIAL_HTTPS_URL`。資料只進入草稿；核對後發布。不要把 `.local/db.json` 整份複製到正式 Firestore，其中可能混有測試帳號。

首次主檔手動匯入完成後，觀察 weekly job 是否能更新 `settings/catalog`。手動觸發 Scheduler 測試 OIDC；不以開放 worker 未驗證訪問作為修復方式。

## 預算、觀測與備份

`infra/budget.example.json` 提供 NT$500、50%／80%／100% 範例，**尚未建立實際預算**。在 Cloud Billing 預算中選定專案、確認帳戶計費幣別及通知收件人；若帳戶不使用 TWD，需換成實際計費幣別的目標。通知不是硬性停機或費用保證。

另有每日每人 20／全站 200 次 AI 任務建立上限，以及有限 worker 重試。NVIDIA 額度與帳單另行查看。Cloud Run 縮到零仍可能有 Scheduler、Firestore、儲存、備份、映像及網路費用。

Cloud Logging 的應用錯誤只輸出 requestId、錯誤代碼、狀態碼及非敏感 I/O 錯誤碼；不輸出照片、金鑰、健康摘要或問答全文。建立 Cloud Run 5xx、worker 失敗、Scheduler 失敗及費用通知；通知接收者尚待設定。

Firestore 備份每日一次、保留 7 天。另建還原資料庫做演練：

```powershell
./infra/restore-drill.ps1 -ProjectId YOUR_TEST_PROJECT -BackupResource 'projects/PROJECT/locations/REGION/backups/BACKUP_ID' -DestinationDatabase 'restore-drill-20260910'
```

核對測試帳號資料筆數、匯出檔與照護關係，將備份來源、還原時間、核對結果記入驗收報告。腳本不會刪除演練資料庫。Firestore 備份不包含 Firebase Auth 與 Cloud Storage；官方 PDF 依雜湊保存並保留來源清單，正式啟用前另驗證其復原流程。

帳號刪除立即拒絕應用存取，背景工作清除健康資料／裝置／照護關係並刪除 Firebase user。失敗的清除工作在後台重試；备份中的舊資料依 7 天保留期到期。正式刪除完成前不可將任務誤標為成功。

## 發版與回復

正式發版前記錄目前 revision；先在測試專案跑完 `docs/VALIDATION.md` 的雲端驗收。部署腳本保留既有 revision，不刪除舊版本。需要回復時將正式服務流量導回指定的上一個 revision：

```powershell
gcloud run services update-traffic yzt-prod-web --project YOUR_PROD_PROJECT --region asia-east1 --to-revisions PREVIOUS_WEB_REVISION=100
gcloud run services update-traffic yzt-prod-worker --project YOUR_PROD_PROJECT --region asia-east1 --to-revisions PREVIOUS_WORKER_REVISION=100
```

回復應用不會自動回復 Firestore 內容；涉及資料格式改變時需先安排相容遷移與還原演練。正式發布、費用與真實帳號驗收本次尚未執行。
