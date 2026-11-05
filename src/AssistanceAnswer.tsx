import type { GroundedResult } from "../shared/schema";
import { reliableReferenceUrl } from "../shared/assistance";
import { Notice, Speak } from "./components";

/** Retrieved references must not impersonate reviewed product leaflets. */
export function AssistanceAnswer({ result }: { result: GroundedResult }) {
  const answer = result.assistance!;
  return (
    <section className="assistance-answer" aria-label="AI 藥品解說與問答">
      <div className="row spread wrap">
        <span className="tag green">AI 資料協助</span>
        <span className="tag amber">尚未核對完整產品仿單</span>
      </div>
      <p className="assistance-intro">
        沒有收錄仿單，也能繼續了解藥品包裝與藥品資訊。以下將查得的資料與尚待確認的部分分開呈現。
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
          目前沒有能通過核對的藥品解說。仍可問「這款藥有哪些可以核對的一般用途或注意事項？」或查看下方資料缺口。
        </Notice>
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
