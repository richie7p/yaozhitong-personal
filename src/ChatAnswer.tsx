import { useRef } from "react";
import type { GroundedResult } from "../shared/schema";
import { CitationDetails, HealthReferences } from "./Evidence";
import { Button, Notice, Speak } from "./components";
import { SourceReviewNotice } from "./SourceReviewNotice";
import { PlainLanguageStatus } from "./PlainLanguageStatus";
import { SourceReadingNotice } from "./SourceReadingNotice";

const answerStatusLabels: Record<GroundedResult["status"], string> = {
  supported: "已附仿單依據",
  not_found: "依現有仿單資料未發現記載",
  insufficient_data: "目前仿單資料不足",
  refused: "這個問題需要醫師或藥師判斷",
};

/** The server supplies verified claims; chat presents all of them in answer order. */
export function ChatAnswer({ result }: { result: GroundedResult }) {
  const claimRefs = useRef(new Map<number, HTMLElement>());
  const sourceReading =
    result.status === "insufficient_data" && result.sourceReading;
  if (
    result.status === "insufficient_data" &&
    result.sourceReview?.reason === "safety_sections_pending"
  )
    return (
      <div className="evidence chat-answer" aria-label="仿單回答">
        <SourceReviewNotice review={result.sourceReview} />
      </div>
    );
  return (
    <div className="evidence chat-answer" aria-label="仿單回答">
      <div className="row spread chat-answer-status">
        <span
          className={
            "tag " + (result.status === "supported" ? "green" : "amber")
          }
        >
          {sourceReading
            ? "部分內容尚未整理"
            : answerStatusLabels[result.status]}
        </span>
        {result.claims.length > 0 && (
          <Speak text={result.claims.map((claim) => claim.text).join("。")} />
        )}
      </div>
      {result.status !== "supported" && !sourceReading && (
        <Notice>
          {result.status === "refused"
            ? "調整劑量、停藥、診斷與個人用藥判斷，請交由醫師或藥師協助。"
            : "目前可用的仿單資料無法提供完整且有依據的回答。沒有記載不代表沒有風險。"}
        </Notice>
      )}
      <SourceReadingNotice result={result} />
      <PlainLanguageStatus result={result} />
      {result.claims.map((claim, index) => (
        <article
          className="claim chat-answer-claim"
          key={index}
          tabIndex={-1}
          ref={(element) => {
            if (element) claimRefs.current.set(index, element);
            else claimRefs.current.delete(index);
          }}
        >
          <div className="claim-number">
            {String(index + 1).padStart(2, "0")}
          </div>
          <div>
            {(claim.category === "warning" ||
              claim.kind === "warning" ||
              claim.kind === "source_exact_safety") && (
              <span className="tag">警語與注意事項</span>
            )}
            {claim.kind === "source_exact_safety" && (
              <span className="tag">仿單警語原文</span>
            )}
            {claim.kind === "source_plain_language" && (
              <span className="tag">AI 白話說明</span>
            )}
            {claim.kind === "source_exact_purpose" && (
              <span className="tag">仿單用途原文</span>
            )}
            <HealthReferences claim={claim} />
            <p>{claim.text}</p>
            <CitationDetails citations={claim.citations} result={result} />
          </div>
        </article>
      ))}
      {result.followups?.map((followup, index) => (
        <details className="chat-answer-followup" key={index}>
          <summary>{followup.question}</summary>
          {result.claims[followup.claimIndex] && (
            <Button
              className="ghost"
              onClick={() => {
                const target = claimRefs.current.get(followup.claimIndex);
                target?.focus({ preventScroll: true });
                target?.scrollIntoView({
                  block: "nearest",
                  behavior: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? "auto"
                    : "smooth",
                });
              }}
            >
              回看相關回答
            </Button>
          )}
        </details>
      ))}
      {result.rejectedCount > 0 && (
        <div className="chat-answer-validation">
          <Notice>{result.rejectedCount} 條內容未通過驗證，已隱藏。</Notice>
        </div>
      )}
      <p className="fine">
        AI 整理與模型輔助驗證仍可能有誤，請以原文核對；內容供用藥資訊理解參考。
      </p>
    </div>
  );
}
