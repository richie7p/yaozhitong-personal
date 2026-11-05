import type { GroundedResult } from "../shared/schema";
import { reliableReferenceUrl } from "../shared/assistance";
import { Notice, Speak } from "./components";

/** Retrieved references must not impersonate reviewed product leaflets. */
export function AssistanceAnswer({ result }: { result: GroundedResult }) {
  const answer = result.assistance!;
  const readableSources = answer.sources.flatMap((source) => {
    const url = reliableReferenceUrl(source.url);
    return url ? [{ ...source, url }] : [];
  });
  const generationIncomplete = answer.uncertainties.some((text) =>
    text.includes("AI 回答格式無法核對"),
  );
  return (
    <section className="assistance-answer" aria-label="AI 藥品解說與問答">
      <div className="row spread wrap">
        <span className="tag green">一般藥品資訊</span>
      </div>
      <p className="assistance-intro">
        依查得的官方與醫療機構資料整理，不必先核對完整仿單。請留意來源適用的成分與劑型；這不是個人用藥指示。
      </p>
      {result.status === "refused" && (
        <Notice>
          這個問題涉及個人用藥判斷，請向醫師或藥師確認。你仍可詢問藥品標示或藥品的一般資訊。
        </Notice>
      )}
      {answer.claims.length > 0 && (
        <Speak
          text={
            answer.claims.map((c) => c.text).join("。") +
            "。仍有資訊尚待確認，請閱讀下方說明。"
          }
        />
      )}
      {answer.claims.map((claim, index) => (
        <article className="assistance-claim" key={index}>
          <span className="tag">
            {claim.basis === "user_label"
              ? "依你確認的藥品標示"
              : "可靠來源的一般資訊"}
          </span>
          <p>{claim.text}</p>
          {claim.basis === "user_label" ? (
            <small className="muted">
              這是文字整理，未判定處方是否適合你。
            </small>
          ) : (
            <ul className="assistance-sources">
              {claim.sourceIds.map((id) => {
                const source = answer.sources.find((s) => s.id === id);
                const url = source && reliableReferenceUrl(source.url);
                return source && url ? (
                  <li key={id}>
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {source.title || new URL(url).hostname} ↗
                    </a>
                    <small>
                      {source.kind === "indexed_leaflet"
                        ? "本站收錄原文"
                        : source.kind === "official"
                          ? "官方醫療資料"
                          : "醫療機構資料"}{" "}
                      · {new URL(url).hostname}
                    </small>
                  </li>
                ) : null;
              })}
            </ul>
          )}
        </article>
      ))}
      {result.status !== "refused" && !answer.claims.length && (
        <Notice>
          {answer.searchState === "unavailable"
            ? "這次網路來源搜尋或讀取未完成。請稍後再查詢；若下方已有參考來源，可先開啟閱讀。"
            : answer.searchState === "not_found"
              ? "這次沒有找到與查詢名稱相符、可引用的藥品資料。可改用包裝上的英文藥名，或補上完整名稱與劑型再查詢；例如眼藥膏與皮膚藥膏需要分開確認，不必先填個人用量或使用次數。"
              : generationIncomplete
                ? "已找到參考資料，但這次 AI 整理未完成。可先閱讀下方來源，或稍後重新查詢。"
                : "已找到參考資料，但尚未整理出有充分依據的用途與注意事項。請對照下方來源的藥名、成分與劑型；補充包裝文字後可重新查詢。"}
        </Notice>
      )}
      {!answer.claims.length && readableSources.length > 0 && (
        <section aria-label="查得的參考來源">
          <h3>查得的參考來源（尚未形成解說）</h3>
          <p className="fine">
            這些來源供你查閱，尚不能據此確認手上產品的用途或適用性。
          </p>
          <ul className="assistance-sources">
            {readableSources.map((source) => (
              <li key={source.id}>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.title || new URL(source.url).hostname} ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <aside className="assistance-uncertainties" aria-label="尚待確認的部分">
        <h3>尚待確認的部分</h3>
        <ul>
          {answer.uncertainties.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      </aside>
      <p className="fine">
        查詢時間：
        {new Date(answer.checkedAt).toLocaleString("zh-TW", {
          timeZone: "Asia/Taipei",
          hour12: false,
        })}
        （臺灣時間）。AI
        解讀與回答仍可能有誤，請開啟來源核對；不代表完整仿單或個人處方建議。
      </p>
    </section>
  );
}
