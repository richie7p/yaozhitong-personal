import type { GroundedResult } from "../shared/schema";
export function PlainLanguageStatus({ result }: { result: GroundedResult }) {
  const coverage = result.plainLanguageCoverage;
  if (!coverage?.fields.length) return null;
  const complete = coverage.fields.filter(
    (field) => field.status === "complete",
  ).length;
  const quizzed = coverage.fields.filter(
    (field) => field.quizIds.length > 0,
  ).length;
  return (
    <aside className="notice" aria-label="白話說明與測驗範圍">
      <div>
        <strong>
          已辨識欄位：{complete}／{coverage.fields.length} 完成白話整理
        </strong>
        <p>內容經模型輔助核對；仍請展開仿單原文確認適用條件。</p>
        {coverage.fields.some((field)=>field.reason==="reverification_failed") &&
          <p role="status">部分說明這次重新核對未通過；下方只顯示本次可核對的內容，請一併閱讀完整仿單原文。</p>}
        {coverage.fields.some((field)=>field.retainedAfterRecheck) &&
          <p role="status">部分補充這次尚未完成核對，已保留先前核對的說明與測驗；尚未完成的內容請對照原文。</p>}
        {coverage.progressFromPrevious && <p role="status">
          {coverage.progressFromPrevious.legacyReorganized
            ? "這次已依新版流程重新整理並核對；原有學習與作答紀錄仍保留。"
            : coverage.progressFromPrevious.lostExplainedSpans > 0
            ? "重新核對後，部分舊說明這次尚未完成核對；下方只呈現本次可核對的內容，原學習與作答紀錄仍保留。"
            : coverage.progressFromPrevious.additionalExplainedSpans > 0 || coverage.progressFromPrevious.additionalQuiz > 0
              ? "這次已補充可核對的說明或理解題；尚未完整整理的內容仍以上方範圍標示為準。"
              : "這次尚未增加可確認的教學範圍或理解題。原學習與作答紀錄仍保留，請先對照仿單原文。"}
        </p>}
        {quizzed > 0 && (
          <p>{quizzed} 個欄位附有安全理解題，每題只抽查一個重點。</p>
        )}
        {complete < coverage.fields.length &&
          coverage.fields.some((field) => field.claimIndices.length > 0) && (
            <p>下方已整理部分重點；未完整整理的欄位請一併閱讀原文。</p>
          )}
        {complete < coverage.fields.length && (
          <p>
            尚未完整整理：
            {[
              ...new Set(
                coverage.fields
                  .filter((field) => field.status !== "complete")
                  .map((field) => field.sourceSection),
              ),
            ].join("、")}
            。可先閱讀原文。
          </p>
        )}
      </div>
    </aside>
  );
}
