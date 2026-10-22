import type { GroundedResult } from "../shared/schema";
import { OfficialSourceLinks } from "./OfficialSourceLinks";

export function SourceReadingNotice({ result }: { result: GroundedResult }) {
  const reading =
    result.status === "insufficient_data" ? result.sourceReading : undefined;
  if (
    !reading ||
    !["model_source_capacity", "requested_topic_coverage"].includes(
      reading.reason,
    )
  )
    return null;
  return (
    <section
      className="card small source-reading"
      aria-label="尚未整理的仿單內容"
    >
      <h3>部分內容尚未整理</h3>
      {reading.reason === "requested_topic_coverage" && (
        <p>本次問題所問的部分安全主題尚未獲得完整回答。</p>
      )}
      <p>
        AI 尚未整理下方列出的內容，本次回答尚未完整涵蓋這些內容。
        原文中的條件、例外與後續段落請一併閱讀。
      </p>
      {reading.sections.length > 0 && <p>下方保留完整仿單原文，可展開查閱。</p>}
      {reading.sections.map((section, index) => (
        <details key={index}>
          <summary>{section.sourceSection}：展開完整仿單原文</summary>
          {section.citations.map((citation, citationIndex) => {
            const chunk = result.chunks.find(
              (chunk) => chunk.id === citation.chunkId,
            );
            return (
              <blockquote key={citationIndex}>
                {citation.quote}
                <footer>
                  {chunk?.licenseNo} ·{" "}
                  {chunk?.sourceFormat === "html"
                    ? `官方網頁 · 區塊 ${chunk.page}`
                    : `第 ${chunk?.page} 頁`}{" "}
                </footer>
              </blockquote>
            );
          })}
        </details>
      ))}
      {!!reading.unavailableSections?.length && (
        <div>
          <p>本次未載入以下欄位的完整原文，請使用官方仿單原文查看。</p>
          <ul>
            {reading.unavailableSections.map((section, index) => (
              <li key={index}>
                {section.sourceSection} · {section.licenseNo}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!reading.missingTopics?.length && (
        <div>
          <p>
            以下主題尚未找到可核對的完整仿單欄位，不能據此判定沒有相關風險。
          </p>
          <ul>
            {reading.missingTopics.map((topic, index) => (
              <li key={index}>
                {topic.topic} · {topic.licenseNo}
              </li>
            ))}
          </ul>
        </div>
      )}
      <OfficialSourceLinks sources={reading.sources || []} />
      <p className="fine">
        {reading.sections.length
          ? "這部分提供來源原文，尚未提供 AI 說明或理解測驗；"
          : "以上未完成的主題尚未提供完整 AI 說明或理解測驗；"}
        需要個人用藥判斷時，請向醫師或藥師確認。
      </p>
    </section>
  );
}
