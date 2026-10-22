import type { GroundedResult } from "../shared/schema";
import { OfficialSourceLinks } from "./OfficialSourceLinks";

export function SourceReviewNotice({
  review,
}: {
  review: NonNullable<GroundedResult["sourceReview"]>;
}) {
  return (
    <section className="card small source-review" aria-label="仿單整理狀態">
      <span className="tag amber">已取得仿單 · AI 內容待整理</span>
      <h3>AI 說明暫待整理，理解測驗尚未提供</h3>
      <p>
        這份仿單的安全段落尚未完成整理與核對，本次沒有產生 AI 說明或測驗。
        你可以先查閱官方原文，將不清楚的內容提供醫師或藥師協助確認。
      </p>
      <OfficialSourceLinks sources={review.sources} />
      <p>
        你仍可保存藥品與已確認用法，使用用藥提醒與服藥紀錄。
        重複送出相同請求不會完成來源整理；來源更新後，可重新產生說明或提出問題。
      </p>
      <a href="#medications">回到我的藥品</a>
    </section>
  );
}
