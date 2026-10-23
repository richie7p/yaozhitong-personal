# 帳號與檔案備份還原

藥智通把 Firestore、Firebase Authentication 與 Storage 分別備份。Firestore 使用既有每日備份；帳號與檔案由獨立 Cloud Run Job 加密備份，每天台北時間 03:30 執行。操作工具預設只讀，還原寫入新建的隔離專案或私人演練目錄，不能覆寫正式帳號或資料庫。

## 備份內容與保留

| 資料          | 備份內容                                                                                                      | 保留                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Firestore     | 文件、UID 與用藥等關聯資料，使用原生備份                                                                      | 7 天                      |
| Firebase Auth | UID、Email 驗證狀態、原密碼雜湊及完整 SCRYPT 參數、登入供應商 UID、停用狀態、自訂權限、必要的專案與供應商設定 | 加密快照 7 天             |
| Storage       | 固定 generation 的原始位元組、SHA-256、完整原 metadata，以及來源桶設定與 IAM 紀錄                             | 一般檔案 7 天             |
| 上傳照片      | 原始照片保留期限、已知擁有者及內容；快照前已過期的照片只記錄到期狀態，不複製照片內容                          | 延續原建立時間的 1 天期限 |

AES-256-GCM 金鑰存於 Secret Manager，快照固定使用一個明確版本；金鑰不放在 Git、環境變數值或備份檔內。帳號、設定、檔案、manifest 都先在記憶體加密，再寫入啟用 UBLA 及 Public Access Prevention 的獨立私人桶。manifest 最後寫入；未完成的批次不能作為完整快照還原。

照片密文與演練還原的照片都保留原 `customTime`，套用一日 lifecycle。Cloud Storage 的實體清理由背景工作執行；還原工具則立即拒絕過期照片，並在讀取密文之前排除它們。照片到期後密文已被清理，屬於預期狀態，不會使其他有效資料無法還原。下載 token、公開快取設定與 ACL 不會直接套回隔離還原檔案；原 metadata 僅留在加密 manifest 供核對。

## 每日工作與容量

備份 Job 只有一項工作、1 CPU、1 GiB 記憶體、兩個檔案同時處理，最長 3,600 秒且不自動重試。容量護欄為 10,000 個帳號、25,000 個檔案、總計 2 GiB、單檔 32 MiB；超過時整次工作停止並記錄錯誤，不擴大支出或產生完整 manifest。這些是備份容量限制，與每人每日 20 次、全站每日 1,000 次 AI 額度分開。

專用服務帳號對原 Auth、Firestore 和資料桶只有讀取權限；只能在備份桶新增物件，不能覆寫或刪除既有快照。排程身分僅可啟動這個 Job。備份失敗規則已提供在 [recovery-alert.json](../infra/recovery-alert.json)；依目前選擇不設定通知管道，需在 Cloud Monitoring 查看。

## 操作方式

先把 [備份計畫範本](../infra/recovery-plan.example.json)填入正確專案編號、來源桶、私人備份桶與固定金鑰版本。計畫和收據存於 Git 與同步資料夾之外的私人目錄。使用已獲授權的 ADC 身分，先檢查只讀預覽：

```powershell
node --import tsx tools/ops-complete-backup.ts --plan C:/private/backup-plan.json --receipts C:/private/backup-preflight
```

確認精確資源與容量後，使用新的收據目錄並加上 `--execute` 執行。完成後保存 snapshot ID、manifest 路徑、generation 與密文 SHA-256，作為還原時的固定 pin。不能只指定「最新檔案」或可變的金鑰 `latest`。

還原先比對 manifest pin、加密驗證、資源身分與目前的停用／刪除狀態：

```powershell
node --import tsx tools/ops-complete-restore.ts --component files --plan C:/private/backup-plan.json --snapshot-pin C:/private/snapshot-pin.json --receipts C:/private/restore-preflight
```

檔案實際還原需加 `--execute`；目的地限定備份桶內全新的 `drills/<snapshot>/restored/`。工具逐檔核對內容 SHA-256、大小、generation 及安全 metadata；已刪除、停用或無法確認擁有者的照片都不還原。原資料桶不會被寫入。

帳號還原使用 `--component auth`，另指定本次新建、無付費連結的 `--target-project yzt-dr-YYYYMMDD-隨機碼` 與 `--target-project-number`。目標必須為空；所有匯入帳號先停用，保留原密碼雜湊、供應商身分及權限供核對。啟用個別帳號或切換正式服務需要另外的身分與環境核對，工具不自動執行。新的 Google OAuth 網域與供應商設定也需另外確認。

備份映像可使用 `docker build -f Dockerfile.recovery -t recovery .` 建置；需支援 Dockerfile 專用 ignore 檔的 Docker／BuildKit。[專用 allowlist](../Dockerfile.recovery.dockerignore)只納入 package、lock 與三個備份程式檔，原網站映像的 `.dockerignore` 不需修改。映像完成後，以實際 digest 固定部署計畫中的 image。

首次部署工具 [deploy-recovery.ts](../tools/deploy-recovery.ts)提供 0 雲端呼叫的預覽，明確指定 `--execute` 才建立最小角色、專用身分、Job 與 Scheduler。它不覆寫同名資源；若建立結果不明或 IAM 尚在傳播，先依私人 journal 查詢已完成步驟，再處理剩餘資源，不能整批盲目重送。

演練清理使用 [ops-recovery-cleanup.ts](../tools/ops-recovery-cleanup.ts)，同樣先預覽。檔案清理需要完成的還原 journal 及其 SHA-256，只刪本次建立的精確 generation；帳號清理要求本次建立收據、精確專案編號、全數停用且完全相同的 UID 集合，先確認帳號已清空才刪隔離專案。加密備份與正式資源不在清理範圍。

## 驗證範圍與復原邊界

本輪實際雲端演練已驗證 8 個帳號的隔離匯入、6 組原密碼雜湊、Google 供應商 UID、自訂權限及停用狀態；一個既有一般合成帳號以原密碼登入成功，錯密碼與停用登入均被拒絕。3533 個原有檔案已逐 generation 還原並核對 SHA-256，演練副本已清理。六個額外合成控制驗證有效照片與 gzip 原始位元組、已刪除／停用／不明擁有者、過期、下載 token 隔離、密文損壞與重複寫入拒絕；控制桶及明文還原檔案也已清理。實際來源沒有保留中的使用者照片，照片還原證據來自這些合成控制。

修正打包入口後，已從真正的 Scheduler 手動觸發每日 Job，單一工作約 8 分鐘成功結束。最新快照包含 3,605 個檔案、472,924,686 bytes 與 8 個帳號；manifest 與 Auth 已解密讀回，原 3,533 個檔案的 generation、metadata 及 SHA-256 不變，後續補入的 72 個官方原檔也逐筆相符。這 72 檔的證據是備份讀回驗證；前述實際寫入隔離目錄再清理的完整檔案演練範圍為 3,533 檔。匿名讀取 manifest、Auth 及檔案密文皆回傳 403。數據與固定 pin 見 [驗收收據](acceptance/complete-recovery-20261023.json)。

上述已核對快照完成後，另新增 **117 份官方原檔（前輪 68 份、本輪 49 份）**，以及相應的 117 份來源文件、發布指標與技術稽核紀錄。這 117 檔尚待下一次成功排程納入，並逐檔核對備份 manifest、generation 與內容 SHA-256；Firestore 文件另需依其備份時間確認覆蓋。網站原檔讀回與備份讀回分別保留證據。這次只更新待備份範圍，沒有觸發新備份或還原。

Firestore 的獨立還原結果見 [公開使用狀態](PUBLIC-READINESS.md#備份與還原)。三種服務的快照時間不同，不能視為同一個跨服務交易；正式復原需對照 manifest 時間、Firestore 備份時間及最新刪除標記，保留原 UID，核對關聯後才切換服務。

目前的還原工具需要仍可讀取原 Auth 與 Firestore 的最新刪除狀態；現在已消失的 UID 會被排除。若發生大規模 Auth 誤刪，需先人工核定可信的 UID 允許清單，再制定專用還原計畫，避免把正常刪除的帳號一併復活。

備份桶與金鑰目前在同一 Google Cloud 專案，涵蓋資料損毀與錯刪的隔離復原；整個專案遭刪除或管理帳號失去存取權時，仍需獨立專案／帳號的異地副本及金鑰保管安排。目前未驗證 MFA、多租戶、照護關係的實際資料復原或新專案真人 Google OAuth。帳號還原工具遇到 MFA／多租戶帳號會停止，不會省略後繼續宣稱完整。

官方操作依據：[Firebase 匯入帳號](https://firebase.google.com/docs/auth/admin/import-users)、[Cloud Storage lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle)、[Cloud Run 排程工作](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)。
