# TFDA 仿單資料匯入

藥智通以完整許可證字號連結藥品與官方仿單。此工具逐批取得 TFDA 原始檔、保存來源證據，並將通過技術檢查的資料加入雲端。它不呼叫付費 AI，也不修改帳號、AI 配額或應用程式部署設定。

## 資料範圍

2026-10-21 的官方快照包含 66,512 個藥品許可證及 29,891 筆仿單索引。以當日有效、未註銷的藥品為第一階段：

| 範圍 | 數量 |
| --- | ---: |
| 有效許可證 | 21,233 |
| 有官方 HTTPS 仿單連結 | 18,183 |
| 這些產品的來源 URL，跨產品去重 | 20,746 |
| 缺少索引或仿單連結 | 3,050 |

同一藥品可能有多個來源。索引中的一筆資料、下載成功的一個檔案，以及可供網站使用的一份完整仿單，是不同的進度。全部索引中的停用、註銷及身分未明資料保留於盤點中；它們不會成為現行用藥來源。官方資料入口：[西藥仿單資料集](https://data.gov.tw/dataset/9117)。

全索引另有 `all-source-candidates.ndjson`，包含 27,559 個有連結的許可證／索引項目與 30,910 個去重 URL，依有效藥品優先排序。它適合收集原始檔案；網站發布仍只處理有效、身分與內容檢查通過的藥品。HTML 中另外列出的紙本及歷史附件留在抽取證據內，須另行收集，不能把索引 URL 的完成率當作所有附件已齊備。

## 處理流程

1. **盤點**：下載許可證主檔（InfoId 36）與仿單索引（InfoId 39），保存原始回應、時間與雜湊。完整字號包含前綴與重發的 `R`；不能只用六位數字配對。
2. **取得原始檔**：限制官方 HTTPS，每次重新導向都先核對。採四個以內的工作程序、大小與時間上限、有限重試及可續跑 checkpoint。
3. **抽取與檢查**：HTML 保留全文、簡單表格的列與欄，並交代所有正文區塊。PDF 比對三個引擎的完整有序文字、每個實體頁面、圖片與版面風險。
4. **準備候選資料**：核對現行品名、完整字號、索引關聯、效期及來源完整性。超出全文預算的資料保留原檔，不截斷後冒充完整內容。
5. **小批發布**：每批最多 50 款；發布前從原始位元組重新抽取，鎖定候選、索引及雲端快照雜湊。只建立新資料，遇到不同的既有內容即停止。
6. **讀回**：驗證雲端原檔與全文，並檢查既有發布資料維持原樣。

表格合併儲存格、複雜巢狀表格、掃描圖片、疑似 PDF 多欄、版面分析失敗、舊品名及多來源關聯未釐清等情況會留待補正。PDF 版面偵測是保守的風險篩選；未偵測到風險不等於已完成語意或臨床驗證。

原文明示「製劑原料」等分類的資料保留供盤點，不發布為患者仿單。個別下載失敗、超出大小上限或官方缺檔也會記錄原因；批次不會無限重試或自行提高發布上限。

`sourceVerification` 保存自動技術檢查條件及原檔重解析證據，明確記錄 `humanReviewed: false`、`clinicalReviewed: false`。既有八款已發布仿單受保護，其餘已存在的不同發布版本也不能被批次工具覆寫。

## 執行方式

需求：Node.js 22 以上及 Python 3.13。以下目錄請自行選擇；原始檔與 checkpoint 建議放在 OneDrive 及 Git 儲存庫之外。

```powershell
npm ci
python -m pip install -r tools/requirements-tfda.txt

# 全新官方快照；拒絕覆寫非空資料夾。
python tools/build-tfda-inventory.py --output C:/yzt-data/index-20261022

# 逐批下載，重跑會續接同一份凍結清單。
python tools/fetch-tfda-sources.py --inventory C:/yzt-data/index-20261022/active-candidates.ndjson --output C:/yzt-data/corpus-20261022 --limit 100 --workers 4

# 更新抽取器後，只重算本機原檔，不重新下載。
python tools/fetch-tfda-sources.py --inventory C:/yzt-data/index-20261022/active-candidates.ndjson --output C:/yzt-data/corpus-20261022 --reextract-cached --all

node --import tsx tools/prepare-tfda-sources.ts --inventory C:/yzt-data/index-20261022 --corpus C:/yzt-data/corpus-20261022 --output C:/yzt-data/prepared-20261022

# 預設僅離線驗證；manifest 由 prepare 的 summary.json 提供。
node --import tsx tools/publish-tfda-sources.ts --manifest C:/yzt-data/prepared-20261022/batches/BATCH.json
```

`--reuse` 可離線重播已凍結的索引，會核驗原始回應、JSON、證據與 checksum；重播不會更新資料取得時間。下載目錄綁定清單雜湊，換清單須使用新目錄。過期索引必須重新取得，不能藉重播延長有效時間。

雲端發布另須明確指定 `--mode inspect`、專案、儲存桶及新快照路徑；`--mode apply` 還須帶入 inspect 回傳的 `--manifest-sha256` 與 `--snapshot-sha256`。目前發布工具固定支援既有藥智通 TEST 專案，使用既有 Google Application Default Credentials，不在程式或命令列傳入金鑰。

需要持續完成整份清單時，可使用一次性批次工具。`--protected` 是既有已發布字號的 JSON 清單（`leaflets` 陣列，每項含 `licenseNo` 與 `status: "published"`）；工具只更新輸出目錄內的衍生清單。不同 queue 須用不同 corpus。

```powershell
python tools/run-tfda-batches.py --inventory C:/yzt-data/index-20261022 --corpus C:/yzt-data/all-corpus --output C:/yzt-data/full-run --protected C:/yzt-data/published-sources.json --queue all --batch-size 500 --all --publish
```

省略 `--publish` 就只做本機收集與檢查。`--max-batches 1` 可取代 `--all` 先跑小批。失敗後用同一組參數續跑，未完成的發布會沿用原快照與雜湊；原始索引過期、來源改變或檢查失敗時停止，不能藉重開程序解除條件。進行中的發布期間請保留工具版本，以免舊快照因抽取器變更而失效。

## 驗證與進度

```powershell
python -m unittest discover -s tests -p 'test_tfda_*.py'
npx vitest run tests/tfda-source-core.test.ts tests/tfda-source-preparation.test.ts tests/tfda-source-publication.test.ts tests/tfda-pdf-raw-verification.test.ts
npm run typecheck
```

本機 `summary.json`、`progress.json` 及發布紀錄分別記錄盤點、下載、候選與雲端進度。原始大量資料不提交 GitHub。這次雲端小批的結果另存於 [技術驗收紀錄](acceptance/tfda-ingestion-20261022.json)。新藥品的 AI 說明與測驗品質仍需個別評估，資料匯入檢查沒有代替該項評估。
