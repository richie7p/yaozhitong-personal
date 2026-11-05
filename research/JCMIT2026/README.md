# JCMIT2026：固定版本與研究材料

本目錄公開既有研究的 R／B／P 原始碼版本、最終配對結果與部分驗收摘要，建立論文版本的可取得性。發布日期為 2026-11-05；本次整理沒有重新執行論文實驗。

## 固定版本

| 配置 | 原始提交 | 固定標籤 | 研究用途 |
| --- | --- | --- | --- |
| R | `2661ec563eb3ec6a8d2149805020fe822e4c972a` | [paper-20261028-R](https://github.com/richie7p/yaozhitong-personal/tree/paper-20261028-R) | 2026-10-28 封存的來源讀取器 v4 修補配置 |
| B | `f6f8920a14a5a4c83243220faf0df4770729a189` | [paper-20261028-B](https://github.com/richie7p/yaozhitong-personal/tree/paper-20261028-B) | 三個來源邊界檔案回退的配對對照 |
| P | `24d2788f7af9f5a35a3ad73109a194a32dfcae55` | [paper-20261102-P](https://github.com/richie7p/yaozhitong-personal/tree/paper-20261102-P) | 三款合成用法、六份保存輸出的部署案例配置 |

引用時請使用上述完整提交或標籤，不以持續變動的 `master` 或本研究說明分支代替實驗版本。R／B 原有提交與標籤保持不變；P 的標籤在本次公開時建立，指向原提交。

R／B 來自同一個 `yaozhitong-personal` 主工作區。當時將包含未提交修改的 467 個檔案另建 Git 封存：先以修補前的三個檔案建立 B，再恢復主工作區內容建立 R。兩版只差 `server/ai.ts`、`server/source-field-spans.ts`、`server/source-review-result.ts`。B 是實驗配對對照，不是歷史正式發布版；這個獨立封存歷史不表示另一套產品。

P 來自主專案後續開發分支，其官方來源讀取器仍為 v3，外部協助設定為 `reliable-reference-v5`。官方讀取器與外部協助分開編號。P 沒有驗證 R 的 v4 修補；本研究未完成 R／P 的同版整合驗證。

## 公開內容與結果

- [versions.json](versions.json)：完整版本、來源關係、原封存雜湊及公開範圍。
- [source-files-R.sha256.json](source-files-R.sha256.json)：原 R 快照的 467 個來源檔案雜湊。
- [runtime.json](runtime.json)：原量測的 Node、套件鎖定檔雜湊與實際直接依賴版本，移除主機絕對路徑。
- [receipts/source-summary-B.json](receipts/source-summary-B.json)、[receipts/source-summary-R.json](receipts/source-summary-R.json)、[receipts/source-paired-comparison.json](receipts/source-paired-comparison.json)：逐位元組保留原 `replay-final/` 的最終結果，不使用較早的探索性比較。
- [receipts/P-summary.json](receipts/P-summary.json)：從原驗收紀錄衍生、移除帳號及紀錄識別資訊的六份輸出摘要；保留原紀錄雜湊以標示來源。
- [replay_sources.mjs](replay_sources.mjs)：原離線重播程式，搭配可自行設定路徑的 [freeze.example.json](freeze.example.json)。

原 R／B 固定語料共有 3,710 筆來源。B 返回 2,982 筆、待核對 728 筆；R 返回 2,989 筆、待核對 721 筆。配對結果為恢復 7 筆、返回狀態退步 0 筆；另 3 筆既有返回來源的分段改變，但串接引文相同。R 的 65,137 筆返回引用沒有違反所定義的逐字子字串條件。

結果中的 `readable` 是程式欄位名稱，意指來源讀取器返回段落，不是文本易讀性或醫療品質評分。逐字一致性檢查也不等於語義支持、醫療正確性或臨床驗證。

## 取得原始碼

```sh
git clone https://github.com/richie7p/yaozhitong-personal.git
cd yaozhitong-personal
git fetch origin --tags
git worktree add ../yzt-R paper-20261028-R
git worktree add ../yzt-B paper-20261028-B
git worktree add ../yzt-P paper-20261102-P
```

若要閱讀本研究材料，可切換至 `research/jcmit2026-artifacts` 分支，或直接開啟本目錄的網頁。

## 有條件的離線重播

完整凍結語料及原 P 帳號驗收紀錄未包含於本次公開內容。下載這個儲存庫可取得固定程式與結果摘要；**無法僅靠本次公開檔案完整重跑所有論文實驗**。

已持有原凍結語料者，可依以下步驟重播 R／B：

1. 使用原記錄的 Node `22.23.2`，分別在 R、B checkout 執行 `npm ci`。原依賴與鎖定檔資訊見 `runtime.json`；重播使用 `esbuild 0.25.12` 與 `zod 4.5.4`。
2. 將 `freeze.example.json` 複製為此目錄下的 `freeze.json`，把 `source_root`、`control_root`、`corpus_path` 改成自己環境的**絕對路徑**。不要把私人路徑設定提交到 Git。
3. 語料必須為原來的 3,710 筆凍結資料，SHA-256 為 `abe30508884145a43dd135059ef78a8f947defc0abc7a2e1f656c1f33dee98c5`。目前線上來源的重新下載不能當成同一份語料。
4. 在此目錄執行以下命令，以同一個全新輸出目錄保存 B、R 與配對結果。程式不覆寫既有輸出。

```sh
node replay_sources.mjs B replay-output
node replay_sources.mjs R replay-output
```

重播程式禁用網路及模型呼叫，並核對語料與執行所用來源檔案的雜湊。單元測試、瀏覽器測試及 P 的雲端案例需要另外的環境與資料設定；本節不宣稱一鍵重現它們。

## 使用範圍

程式沿用儲存庫的 Apache-2.0 授權與既有來源歸屬。語料原文及外部參考內容的使用仍依各原來源條款。本次公開版本對照不增加醫療品質、真人成效或正式雲端容量的證據，也不包含 IMP 的 E／E2／E3 封存配置。
