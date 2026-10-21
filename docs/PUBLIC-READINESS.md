# 公開試用準備

更新日期：2026-10-21。目前雲端版本為 Web `yzt-test-web-00016-nrw`／worker `yzt-test-worker-00016-lkf`，來源為 `9620da3`。已用三張公開實拍藥袋完成辨識、核對保存、仿單說明、12 題測驗與用藥問答；修正照片規格被目錄覆蓋及明示療程漏填，另以開恩達命原照片重新跑完整流程。最終手機尺寸複驗通過，配額仍為每人每日 20、全站 200 次。照片來源、原始漏辨識、修正後重測及身分限制見[公開實拍雲端驗收](acceptance/cloud-public-photos-20261021.json)。乾淨發布來源通過 910 項單元、146 項桌面／手機尺寸瀏覽器、型別及建置檢查；[GitHub 驗證工作](https://github.com/richie7p/yaozhitong-personal/actions/runs/39616106533/job/119277451616)亦已通過。先前合成兩藥及真人帳號驗收保留於[第二批雲端流程](acceptance/cloud-ux-batch2-20261021.json)與[公開準備驗收](acceptance/cloud-readiness-20261021.json)。

藥智通已具備受控試用所需的帳號隔離、官方來源閱讀、用藥紀錄、背景工作與個人資料管理。雲端 8 份來源、25 題已通過實際 API 流程及原文 QA；新版註冊、驗證信、密碼重設與 Google 登入亦已完成實際確認。現行開放方式是「可註冊、驗證信箱後由管理員核准 AI 資格」，後續擴大開放的重點為公開支援、復原及營運能力。

## 已核對的使用與保護方式

| 項目 | 已核對的行為與設定 |
| --- | --- |
| 註冊與 AI 資格 | Firebase Email／密碼及 Google 已啟用；信箱列舉保護已啟用。雲端新帳號預設 `eligible:false`，驗證信箱不會自行取得 AI 資格。管理員核准最多 50 個有效測試名額；未取得資格仍可手動保存本人資料。 |
| 登入與隔離 | 後端逐次驗證 Firebase token 與撤銷狀態；私人資料依 token UID 授權。Google 另核對原憑證的 audience、subject 與已驗證信箱。分頁登入保存、中斷隔離、登出、換帳及 storage 不可用回歸已通過；使用者已確認新版 Google 登入及重新整理正常。 |
| 雲端入口 | Web 允許公開呼叫；私人 API 仍需登入。Worker 無 `allUsers` Invoker，僅服務帳號可呼叫。資料 bucket 啟用 uniform access 及 public access prevention。儲存庫的 Firestore／Storage client rules 全面拒絕直接存取；歷史雲端規則驗收已通過。 |
| 配額與容量設定 | 目前每日每人 20、全站 200 次新 AI 任務；建立與扣次在交易內完成，同操作重送沿用工作。Cloud Run 服務層級各最多 2 個 instance；Web concurrency 40／timeout 120 秒，worker concurrency 2／timeout 600 秒。Tasks 最多 2 並行、每秒 2 次派送、3 次嘗試。這些數值是受控試用設定。 |
| 圖片與保存 | 工作結束清理照片；data bucket 的 `uploads/` 另設 1 天生命週期，soft delete 為 0、versioning 關閉。保存的用藥、問答與學習資料供本人接續使用。公開資料使用頁已說明供應商處理、匯出、刪除及登入保存方式。 |
| 刪除帳號 | 刪除請求先停用應用帳號並撤銷 Firebase refresh token，再清除本人健康資料、照片、裝置、照護關係及 Firebase user。清理完成後保留最小停用 tombstone，防止 UID 被當成新帳號重建；背景刪除工作本身則會移除。 |

## 全面公開前的完成條件

1. **確定公開使用與支援方式。** 採用明確的資格申請／核准流程、每日額度與容量目標，並在網站提供可實際聯絡的維護者信箱或表單。目前頁面只提供「取得試用連結時的聯絡管道」，尚無一般訪客可使用的公開支援入口。註冊頁最少 8 字元屬前端規則；本次 Auth 設定沒有回傳密碼政策或 Email／密碼 reCAPTCHA 強制設定，公開前需確認服務端策略與註冊、登入、一般 API 的濫用處理方式。

2. **已完成核心帳號生命週期驗收。** 新版網頁以獨立測試別名實際註冊；使用者確認驗證信與重設信兩封皆送達，完成驗證、重設及新密碼登入。後端核對 `emailVerified:true`，原密碼回傳 `400 INVALID_LOGIN_CREDENTIALS`，原主帳號健康資料保留。正常雲端匯出、照護撤銷、完整刪除與 Storage sentinel 清理由兩個全新合成帳號完成 **40／40** 檢查，兩個 Auth user 均已移除。該[生命週期驗收](acceptance/cloud-account-lifecycle-20261021.json)執行於 Web `00011-9gc`／worker `00011-6sd`；刪除路徑本輪未修改，這份結果保留其原驗收版本。雙裝置與明確帳號連結仍列為擴充覆蓋項目。

3. **建立可用備份並完成獨立還原。** 已存在每日備份排程、保留 7 天；本次 `asia-east1` 備份清單為 **0 筆**，資料庫只有 `(default)`，PITR 關閉。取得可用備份後，用 `infra/restore-drill.ps1` 還原至新的 `restore-drill-*` 資料庫，核對資料、照護關係、耗時及復原程序；另驗證 Firebase Auth 與 Storage／官方來源檔案的重建。Firestore 備份不包含這兩者。還原程序也需排除已刪除帳號被舊備份重新帶回服務。

4. **驗證刪除失敗的補救流程。** 目前 cleanup 遇錯會將工作設為 `failed`；Scheduler 自動接手的是 `queued` 或過期 `running`。管理員可重試失敗刪除工作，但共用重試入口在 3 次後會拒絕。需以雲端故障案例驗證人工處理、完成確認與逾期升級方式，並提供使用者可查詢刪除進度的支援管道。

5. **完成告警、負載與費用觀測。** 本次 Cloud Monitoring alert policy 為 **0 筆**。建立並驗證 Web／worker 錯誤、Scheduler／Tasks 失敗及刪除工作滯留的通知送達；以預期同時使用人數核對延遲、拒絕行為與費用。歷史紀錄有 NT$500 費用提醒，本次帳單設定回讀權限為 403，尚未重新確認提醒及收件人。每日 AI 次數、instance 上限與費用提醒各自控制不同範圍，需另外確認 Hosting、Firestore、儲存、備份與 AI 供應商的用量及停用處理方式。

## 驗收依據

[本輪公開準備驗收](acceptance/cloud-readiness-20261021.json)彙整最終版本、收信與帳號結果、來源覆蓋及實際雲端 AI 驗收；[正常雲端帳號生命週期](acceptance/cloud-account-lifecycle-20261021.json)保留其獨立版本與範圍。上述其餘四項營運門檻完成後，再將開放範圍與額度更新為實際採用政策。公開文件不保存測試信箱、UID、token 或原始健康資料。

設定與實作依據：[部署與復原說明](DEPLOYMENT.md)、[歷史雲端驗收](acceptance/cloud-first-deploy-20261020.json)、[API 與資料授權](API.md)、[帳號／資格／刪除實作](../server/domain.ts)、[工作恢復](../server/scheduler.ts)、[登入驗證](../server/auth.ts)、[公開資料使用頁](../src/Privacy.tsx)。備份、告警及費用權限的設定快照於 **04:22–04:24 UTC** 唯讀取得。
