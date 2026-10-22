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
          完整白話整理 {complete}／{coverage.fields.length} 個安全欄位
        </strong>
        <p>內容經模型輔助核對；仍請展開仿單原文確認適用條件。</p>
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
