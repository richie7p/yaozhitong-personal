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

TFDA 主檔的「藥品類別」若為原料藥、製劑原料或醫藥原料，資料僅供封存，不發布為患者仿單。準備候選與發布時都會檢查；發布工具會自行讀取原始官方主檔，不能只相信候選資料的分類。缺少或矛盾的分類也會保留待處理。原文另外出現原料分類時仍會攔截。個別下載失敗、超出大小上限或官方缺檔均記錄原因。

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

準備大量候選時，可用 `--source-format html` 或 `--source-format pdf` 分批處理，預設 `all`。兩種格式使用不同輸出目錄，並各自保存 summary 與 manifest。格式選擇只決定當次要處理的原始主來源；同款藥品的全部索引分支、缺檔狀態及其他格式附件仍參與完整性核對，不會改選另一個較容易處理的來源。summary 的 `sourceFormat`、`selectedSourceCounts` 及 `deferredSourceCounts` 會列出選擇範圍；延後處理不計入完成或發布數。

雲端發布另須明確指定 `--mode inspect`、專案、儲存桶及新快照路徑；`--mode apply` 還須帶入 inspect 回傳的 `--manifest-sha256` 與 `--snapshot-sha256`。目前發布工具固定支援既有藥智通 TEST 專案，使用既有 Google Application Default Credentials，不在程式或命令列傳入金鑰。

需要持續完成整份清單時，可使用一次性批次工具。`--protected` 是既有已發布字號的 JSON 清單（`leaflets` 陣列，每項含 `licenseNo` 與 `status: "published"`）；工具只更新輸出目錄內的衍生清單。不同 queue 須用不同 corpus。

```powershell
python tools/run-tfda-batches.py --inventory C:/yzt-data/index-20261022 --corpus C:/yzt-data/all-corpus --output C:/yzt-data/full-run --protected C:/yzt-data/published-sources.json --queue all --batch-size 500 --all --publish --extract-active-from C:/yzt-data/index-20261022/active-candidates.ndjson --fetch-workers 2
```

省略 `--publish` 就只做本機收集與檢查。`--max-batches 1` 可取代 `--all` 先跑小批。失敗後用同一組參數續跑，未完成的發布會沿用原快照與雜湊；原始索引過期、來源改變或檢查失敗時停止，不能藉重開程序解除條件。進行中的發布期間請保留工具版本，以免舊快照因抽取器變更而失效。

`--extract-active-from` 將有效藥品清單的 SHA 綁定至下載 checkpoint；其餘網址只保存官方原檔，不花時間解析歷史資料。與有效藥品共用的網址仍會正常抽取。綁定後不能省略或換成不同的清單。`--fetch-workers` 可設為 1 至 4；同時執行附件封存時，兩個程序的工作數合計應維持在 4 以內。

大量原檔已累積時，可加上 `--fetch-all-once`，讓下一個尚未完成的下載階段一次取得凍結清單內的剩餘網址，避免每 500 筆重複掃描所有既有檔案。它必須與 `--all`、`--queue all` 及 `--extract-active-from` 並用；原檔 SHA 驗證、有效藥品抽取條件和失敗處理維持原樣，雲端發布每批仍最多 50 款。若已有保存的下載報告，工具會先續接準備及發布，不重抓該批。

只讀 inspect 遇到明確的連線重設、服務暫時不可用或期限錯誤時，最多嘗試兩次。驗證失敗、權限、配額、未知錯誤及 apply 失敗不會自動重試。診斷僅輸出標準錯誤代碼，不輸出 SDK 請求或憑證。

## 附件封存與資料更正

`tools/archive-tfda-assets.py` 另外收集電子仿單列出的現行紙本、歷史附件與圖檔。其 queue 必須先凍結並計算 SHA；每個 queue 使用獨立輸出資料夾。封存程序不寫入雲端，也不將檔案直接發布為患者仿單。

```powershell
python tools/archive-tfda-assets.py collect --queue C:/yzt-data/assets.ndjson --output C:/yzt-data/asset-archive --reuse-corpus C:/yzt-data/all-corpus --cohort oversize --limit 10 --workers 2
# 核對小批 summary.json 與原檔後，對同一 queue 續跑所有附件。
python tools/archive-tfda-assets.py collect --queue C:/yzt-data/assets.ndjson --output C:/yzt-data/asset-archive --reuse-corpus C:/yzt-data/all-corpus --cohort all --limit 50000 --workers 2
```

附件封存每檔上限 100 MB、單次請求期限 90 秒，最多兩次嘗試；患者仿單發布的 15 MB 上限及抽取檢查維持原設定。`--reuse-corpus` 可重複指定既有下載或封存資料夾，重用前核對實際 bytes 與 SHA；相同網址取得不同版本時全部保留，不自行判定現行版本。報告分列成功網址數、網址／版本參照數及不同 SHA 原檔數。

### 官方頁面連結的現行紙本

紙本 PDF 可以透過原始官方電子頁面建立來源關聯。這條流程會重新解析 Info39 指向的 HTML，核對現行藥品身分、所有來源分支，以及唯一的現行紙本連結；候選自行聲稱的關聯或 SHA 不能取得發布資格。明確分離、官方 HTTPS 且與現行連結互斥的歷史紙本及電子頁面，會按原始順序完整列出並排除。歷史內容不加入現行正文；未分類、角色矛盾或有多個現行連結的資料仍留待處理。

紙本本身仍須通過原有的三引擎全文比對、每頁及版面檢查。發布時重算官方頁面與 PDF 的證據，並以只新增方式保存兩份原始檔。關聯證據上限為 100 KB，完整發布文件上限為 800 KB；超限保留原檔，不截短證據或正文。

```powershell
# 先完成主流程，再從雲端實際發布指標產生新的 protected 清單。
# 同款藥品若主流程已發布 HTML，紙本流程就保留既有來源。
node --import tsx tools/prepare-tfda-parent-papers.ts --inventory C:/yzt-data/index-20261022 --corpus C:/yzt-data/all-corpus --archive C:/yzt-data/asset-archive --output C:/yzt-data/current-paper-prepared --protected C:/yzt-data/current-published.json --limit 5000

# 預設只有離線驗證；雲端 inspect/apply 仍須原有的明確專案、桶及快照雜湊。
node --import tsx tools/publish-tfda-sources.ts --manifest C:/yzt-data/current-paper-prepared/batches/BATCH.json --parent-paper-mode strict-v2
```

`--limit` 是本機準備工作的上限，範圍 1 至 5,000；每份雲端 manifest 仍最多 50 款。檢查 summary 的 `counts.deferred_by_limit`、`selection` 及 `evaluationCoverageStatus`，確認是否仍有未處理項目。重跑會重新評估候選，已保存的輸入與 manifest 不覆寫。主流程與紙本流程應依序發布，避免兩種格式同時競爭同一許可證。

`--license-list` 可讀取含 1 至 5,000 個不重複完整字號的 JSON 陣列，並保存選集的路徑、SHA 與筆數；不能與 `--license` 並用。離線排程可先排除主流程待發布的相同產品，但這些候選不能算成已發布。正式紙本發布前仍須以雲端實際指標重新建立 protected 清單。舊版 v1 試跑資料保留作為離線證據，發布須重新產生 v2 來源證據。詳細選集用法見 [紙本來源工具說明](../tools/README-tfda-parent-papers.md)。

成分表常見的點線不會改寫原文；文字品質檢查只對同一來源行、兩端為文字或數字的正常點線作例外。其他重複字元、亂碼、最低有效字數及文字比例門檻維持原設定。

固定三筆曾誤納原料藥的更正使用 `tools/withdraw-tfda-raw-materials.ts`。預設 inspect 僅保存完整前快照；apply 須指定精確快照 SHA，並在交易中核對原仿單、發布指標及稽核紀錄。更正只將該來源退役並移除患者發布指標，保留原檔與全文。restore 以同一快照和擁有權紀錄恢復，遇到競爭變更即停止；不修改帳號、服藥紀錄或配額。

## 驗證與進度

```powershell
python -m unittest discover -s tests -p 'test_tfda_*.py'
npx vitest run tests/tfda-source-core.test.ts tests/tfda-source-preparation.test.ts tests/tfda-source-publication.test.ts tests/tfda-pdf-raw-verification.test.ts tests/tfda-source-format.test.ts tests/tfda-legacy-title-check.test.ts
npm run typecheck
```

本機 `summary.json`、`progress.json` 及發布紀錄分別記錄盤點、下載、候選與雲端進度。原始大量資料與測試帳號資料保留於本機。初始小批結果見 [初始驗收紀錄](acceptance/tfda-ingestion-20261022.json)，本輪擴充結果見 [仿單擴充與雲端抽測紀錄](acceptance/tfda-leaflet-expansion-20261022.json)。

截至 2026-10-22，雲端共有 **2,025 款**仿單，本輪從 1,804 款新增 **221 款**：207 份 HTML、7 份直接 PDF、7 份經官方頁面確認關聯的紙本 PDF。既有八款維持原樣，三筆退役原料藥沒有患者發布指標。全量讀回核對了 2,032 個原始物件，包含七份紙本的官方父頁。

兩筆既有 PDF 的完整品名因中英文交錯排版與引號字形差異，被原名稱檢查標記。`tools/tfda-legacy-title-check.ts` 另以原始第一頁的完整中英文標題、官方索引及原檔 SHA 完成補充核對，原始報告仍保留。這項診斷只處理既有來源的標題排版，不授予新來源發布資格。

| 現行資料範圍 | 數量 |
| --- | ---: |
| 有官方索引來源、已發布的完整字號 | 2,025 |
| 有官方索引來源、尚未發布的完整字號 | 16,158 |
| 缺少索引或來源連結的完整字號 | 3,050 |
| 現行索引網址已取得原檔 | 20,743／20,746 |

尚未發布的集合包含原料藥，以及掃描圖、複雜版面、抽取不一致、現行品名或多來源關聯待釐清的資料。取得原檔仍須經過內容與身分檢查才能發布。另有 11 筆未分類解析操作錯誤，在一次有限重試後仍待診斷；非現行來源的封存工作保留 8,513 個待下載網址及 27 個失敗網址。批次匯入使用 0 次 AI；配額維持每人每日 20 次、全站每日 200 次及 50 個試用名額。

雲端網站以既有一般測試帳號完成三筆合成藥品的核對保存，抽測賽普寧錠（HTML）與麻舒痛乳膏（PDF）的說明、共十題理解測驗、重新整理及問答歷史，並檢查 375px 版面。一般問答保留「尚無資訊」的不確定性；涉及自行用藥的 PDF 問題採取拒答，未產生原定的矛盾段落解釋。缺少來源的第三款顯示「目前仿單資料不足」，沒有生成說明或測驗，也沒有呼叫模型。

本輪網站測試共使用五次任務額度、七個模型 HTTP 請求；恢復驗收沿用原結果。原有十九筆藥品與試用名額紀錄維持原樣。此次為兩款來源的功能抽測；全部 2,025 款的生成內容尚未逐款評估，部分測驗選項措辭也仍需改善。
