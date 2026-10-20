# 研討會本機展示

這次展示驗收涵蓋藥袋辨識、使用者逐筆核對藥品字面、仿單說明、理解測驗及資料保存，不安排藥師簽核作為展示前置。現行副本包含合成雙藥袋、Bubdel歷史公開實拍，以及三款手動建檔的合成用法；**不是六款藥全部實拍，也不是臨床驗證或個人處方判斷。** 公開照片的歷史病人欄位不作虛構人物資料，只取藥品字面。

2026-10-20現行：`gpt-6-luna`、`grounded-v11-whole-warning-source-sections`。六份已核對官方來源、六份保存說明、七題已採用至8085；三藥各兩次、Bubdel實拍兩次及原兩藥合成袋流程共10份內容，22條說明／12題／34次引用逐項通過第一QA。採用的六份另經[第二角色QA](../.local/seminar-demo-expanded-v11-20261020/second-demo-content-qa.json)核對14條說明及7題，全部已發布內容有自身來源支持，**警語摘要仍非全仿單覆蓋**。完整測試為[單元328／328](../.local/reports/seminar-unit-v11.json)、[桌面／手機回歸36／36](../.local/reports/seminar-e2e-v11-final.json)、[故障恢復10／10](../.local/seminar-recovery-openai-1792459130218/report.json)，正式建置通過。[服務重啟保存介面22／22](../.local/seminar-demo-expanded-v11-20261020/service-restart-ui-report.json)及[本次真Windows重開後14／14](../.local/reports/seminar-postboot-summary-v11-20261020.json)均通過，保存檢查0新AI。來源、固定分母、失敗歷史與用量見[擴充驗收](SEMINAR-EXPANDED-20261020.md)。

2026-10-20兩藥v9 Luna歷史：先前[固定五輪完整流程5／5、15／15任務、25／25 HTTP 200](../.local/reports/openai-luna-acceptance-20261020.json)，0逾時／重試／NVIDIA備援，10包、20條說明、12題及32次引用通過來源QA；舊 `.local/seminar-demo-luna-20261020` 保存副本的服務重啟／介面14／14保留。它們不代替新六藥v11驗收，也不是新副本整機重開證據。

2026-10-19 NVIDIA 歷史：文字與影像主模型均為 `nvidia/nemotron-3.5-super-vl-120b-a12b`，兩者備援均為 GLM 5.3 Flash；內容規則為 `grounded-v9-source-quote-explanations`。前兩批固定五輪各 3／5；當時雙路由第三批為 **1／5 完整通過，13 個已建立任務中 8 成功、5 逾時，另 2 份說明未建立**，失敗全部保留，未再刷第四批，不能宣稱 NVIDIA 即時服務穩定。完整結果及尚餘事項見 [本次驗收摘要](SEMINAR-ACCEPTANCE.md)，逐輪及歷史失敗見 [VALIDATION.md](VALIDATION.md)。

## 開啟指定展示

在專案資料夾雙擊 **`啟動研討會展示.cmd`**，等啟動完成後開啟 [展示頁](http://127.0.0.1:8085/#learning)，選「本機使用者」。啟動器會先檢查資料、來源及目前內容版本，通過才啟動；再次執行會沿用符合資料路徑與程序身分的既有服務。若 8085 被其他服務占用，會停止並提示處理，不會關閉未知程式。

指定資料夾為 **`.local/seminar-demo-expanded-v11-20261020`**，啟動器與目前8085服務均已切換。它包含66,511筆官方主檔、6藥／6份說明／7題／8個歷史任務，其中2個辨識任務。基底是[v11原兩藥流程](../.local/seminar-flow-1792459194673-feacad46/report.json)，再按逐筆內容QA加入[三款手動藥品各首例](../.local/seminar-expanded-1792459206074-51ee3a72/report.json)及[Bubdel實拍首例](../.local/seminar-expanded-1792459326278-6ec3002d/report.json)；所有重複驗收與失敗另存，不以選入展示的首例代替固定分母。**模型原始說明、題目、答案與任務紀錄保持，原始驗收目錄不改。** 來源及合併證據見[展示準備紀錄](../.local/seminar-demo-expanded-v11-20261020/demo-preparation.json)。現場須標明這是預先完成的真實模型結果。

全部本輪結果集中於[驗收總表](../.local/reports/seminar-expanded-acceptance-v11-20261020.json)：9/9操作流程、13個任務、23次真實Luna呼叫。9個流程共產生10份學習內容，兩種分母分開計算，也不代替所有手機／光線的測試。

預載結果可直接從「我的藥品」「用藥小教室」及「AI處理紀錄」開啟，不增加模型任務。辨識對照圖有[合成雙藥袋](../.local/seminar-demo-expanded-v11-20261020/synthetic-two-medication-bag.png)與[Bubdel公開實拍原圖](../.local/seminar-public-photos-20261020/commons-cgmh-original.jpg)；實拍作者、授權及限制見[擴充驗收](SEMINAR-EXPANDED-20261020.md#新來源核對與保留缺口)。重新上傳或產生新說明才會呼叫真實AI，須額外預留等待。這份本機資料不加入Git，換電腦須另行準備。

## 五分鐘展示順序

1. **0:00–1:00｜實拍辨識與保存結果**：對照Bubdel公開實拍與「帳號與設定 → AI處理紀錄」中的已保存辨識，展示藥名、80mg/tab、每次1粒、需要時及口服等字面，說明是歷史公開照片的預先辨識。已有保存狀態，不需重送AI；不把照片用法判成虛構成人可使用的處方。可補看合成雙藥袋，明講其為合成測試。
2. **1:00–2:30｜不同劑型與來源**：在「我的藥品／用藥小教室」看六藥清單，選乳膏展示「適量」文字用量，再看安佳熱完整肝毒性警語或優克黴素真實「效能／附記」欄，展開自身原文及官方PDF。**安佳熱、乳膏、優克黴素為手動建檔，使用合成用法，不能說是三張實拍辨識成功。** 簡要提醒摘要未涵蓋全部警語。
3. **2:30–4:00｜理解測驗**：選優克黴素，先按「重新複習」，答錯用途或警語題，展示本題「依仿單原文」解釋及引用，再改答正確。全副本共7題：酵素、咳服、安佳熱、乳膏、Bubdel各1題，優克黴素2題；其中只有優克黴素含1題警語題，不宣稱所有警語理解都已測到。不考個人劑量。
4. **4:00–4:40｜保存與續接**：重新整理或登出登入，確認已提交答案與進度仍在。桌面及375px已逐題檢查錯題、原文、重答與保存；正式服務重啟22項及真正Windows重開後14項檢查均通過，沒有重送AI。
5. **4:40–5:00｜範圍與待補**：提醒、PRN分流及藥箱只作補充。明講目前只有2張歷史公開實拍、其中Bubdel完成整個流程；息咳寧仍缺可確認口味的完整來源、HEIC未支援，雲端登入、實機推播及長期可用性另驗。現場臨時新上傳屬額外即時展示，不納入這份五分鐘保存流程。

## 等待、失敗與恢復

每次生成、審核或辨識的所有嘗試共用 45 秒，單一任務共用 120 秒；每次呼叫最多 3 個 HTTP 請求。現行 OpenAI Luna 沒有跨供應商備援，只有暫時限流、5xx 或網路等暫時故障在原期限內重試；額度限制、拒絕、格式／來源驗證失敗或截斷會保留失敗，不發布部分內容。每次模型、階段、耗時、狀態與未知用量保存在原任務。開場前確認網路、API 額度、服務及預載內容可用；舊 NVIDIA 12／22 秒路由政策只作歷史，詳見 README。

新辨識失敗時不自動建立藥品，可重新選取清楚的受支援圖片再上傳。說明任務逾時或忙碌時，輸入保留在「AI處理紀錄」，可用**原任務重試**，避免連續建立相同任務。格式／來源失敗不發布部分內容；超長或不完整來源先保守拒絕。現場等待影響節奏時，回到已通過來源核對的保存結果，繼續說明與測驗，並標示預先完成。

辨識已成功但尚未核對完，可從處理紀錄續接；儲存回覆遺失後重送會取回原筆，不重複或覆寫。程序中斷後重新啟動、重新登入即可續接已保存資料。程序強制中止、未到期工作租約、逾時／忙碌重試與冷啟動已另用假的 AI 上游測試，詳細證據見驗收摘要。

## Windows 重開機後

2026-10-19 原 `.local/seminar-demo-v9-20261019` 已完成真正 Windows 整機重開驗收：不同 boot ID、資料集合無差異、啟動器與 API 資料一致；重開後桌面／375px 的辨識結果續接、三題原文與錯題重答、重整保存共 6／6 通過，沒有新增 AI 請求。報告固定保存於 [v9 歷史整機驗收總表](../.local/reports/seminar-postboot-summary-v9-history.json)，不當作新資料副本又重開過的證據。

目前六藥v11副本已完成本次真正Windows整機重開驗收。使用者自行手動重開後，代理接手啟動指定8085展示並驗證；boot ID從`2026-10-19T14:42:00.500Z`改為`2026-10-20T01:37:26.500Z`，6藥／6份說明／7題／8任務／2筆辨識及6份生成記錄均一致，保存集合沒有變更，API及啟動器身分相符。[本輪重開總表](../.local/reports/seminar-postboot-summary-v11-20261020.json)、[凍結OS／資料報告](../.local/seminar-demo-expanded-v11-20261020/windows-reboot-report.json)與[重開後UI 14／14](../.local/seminar-demo-expanded-v11-20261020/postboot-ui-report.json)保留證據；桌面及375px核對三筆已保存辨識藥品續接、六份內容的七題答錯／原文／答對／重新整理，0新AI，原內容、最終答案、任務及請求指標不變。這與重開前的[服務重啟22／22](../.local/seminar-demo-expanded-v11-20261020/service-restart-ui-report.json)分開計數。沒有安排自動重開或開機自動常駐；之後使用 **`啟動研討會展示.cmd`** 開啟，**`重開機後驗收.cmd`** 則是完整資料及保存介面的驗收入口。舊兩藥Luna與NVIDIA ready的14／14只作各副本歷史。

## 首次裝置準備與 AI 設定

首次裝置先安裝 Node.js 22，執行 `npm ci`、`npm run prepare:local:demo`、`npm run build`，再準備指定展示副本。官方來源準備需要網路，不呼叫 AI；來源改版或 SHA 不符會停止。一般空白本機模式可用 `npm start` 開啟 8080，和指定 8085 展示資料分開。

先前 NVIDIA 設定採 SuperVL 主模型、GLM 備援，文字主模型 12 秒、影像 22 秒；這些是舊保存展示的歷史來源，沒有作為 OpenAI 的自動備援。

目前本機設定為 `AI_PROVIDER=openai`，文字、影像與審核均為 `gpt-6-luna`；金鑰僅存於Git忽略的後端設定。Luna使用Chat Completions、`reasoning_effort=none`、`store=false`及JSON模式，45秒呼叫／120秒任務與來源檢查保持，沒有跨供應商備援。none／low／medium的小型對照未證明提高推理能修好來源半句，正式保持none；詳見[擴充驗收](SEMINAR-EXPANDED-20261020.md#luna推理設定的小型比較)。設定優先順序與官方文件見[README](../README.md#ai-供應商與本機設定)。

`npm run check:openai:ready` 可在建置後檢查本機準備狀態，0 次供應商呼叫，報告為 `.local/reports/openai-readiness.json`。本次預檢、最小連線、固定五輪真實驗收與來源核對各自留有報告；準備狀態不代替真實驗收，也不改寫 NVIDIA 歷史結果。

## 展示範圍與歷史證據

- 核對六份固定官方PDF：酵素000544、咳服026087、安佳熱040161、克黴隆039632、優克黴素019054、Bubdel030418。主檔66,511筆不代表每筆都有已核對仿單；Bubdel影像PDF靠完整人工轉錄及第二次視檢，未宣稱通用OCR已修。
- 說明及題目經軟體來源、條件與唯一答案核對；不是臨床準確率或個人用藥安全認證。`source_quote` 解釋直接使用本題已確認原文，不採模型自由補述。
- 本機身份、站內提醒及檔案保存可展示；關閉程式後沒有背景鬧鐘。正式雲端、Firebase 真實登入及實體裝置推播另行驗證。
- 安佳熱／Bubdel的摘要仍有警語覆蓋缺口；全副本7題只有1題警語題，不宣稱全警語理解已量測。詳見[逐項限制](SEMINAR-EXPANDED-20261020.md#尚未補齊的範圍)。公開實拍只有兩張，不能概括所有手機／光線；歷史病人資料不判定個人適用性。
- v7引用不完整、v8自由解釋跨段、v9／v10失敗及各版503／逾時均保留在[驗證紀錄](VALIDATION.md)與[擴充驗收](SEMINAR-EXPANDED-20261020.md)。逾時沒有usage時，用量未知，不能當成零。舊v7／v9／兩藥Luna／NVIDIA副本及手動備案保留歷史，現行使用expanded-v11指定副本。

本機原始PDF：[酵素](../.local/seminar-demo-expanded-v11-20261020/blobs/leaflets/e9c0bbe6d525934b14ff4f620e6869000e0bf432c50157fc2ade80634bd212e7.pdf)、[咳服](../.local/seminar-demo-expanded-v11-20261020/blobs/leaflets/553a71ac6af8b49791d957058ab128d505f871f582a67e875c8f177abd18ab0b.pdf)、[安佳熱](../.local/seminar-demo-expanded-v11-20261020/blobs/leaflets/a4a0671a2cb2a32db72f0efb010bdebd17631493931d5da68da977123fde8d3d.pdf)、[克黴隆](../.local/seminar-demo-expanded-v11-20261020/blobs/leaflets/bd83f3badd8987d43703ddacc0e8b3c4c17c8f1edd0598097c181b1fe67957a9.pdf)、[優克黴素](../.local/seminar-demo-expanded-v11-20261020/blobs/leaflets/56185a4d930542fd18261ad73df466d56a0fe85a340ca88fb33b5d95369114ad.pdf)、[Bubdel](../.local/seminar-demo-expanded-v11-20261020/blobs/leaflets/3b4dbe2ad392ccd552fcf6dec4035954e3d0632a2cc212939df574275b057dd7.pdf)。日常操作見[LOCAL-TESTING.md](LOCAL-TESTING.md)。
