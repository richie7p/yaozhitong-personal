import type { DrugExplanationResult } from "../shared/drug-explanation";
import { reliableReferenceUrl } from "../shared/assistance";
import { Evidence } from "./Evidence";
import { Notice } from "./components";

/** A label-based lookup is never presented as a confirmed product identity. */
export function DrugExplanation({ result }: { result: DrugExplanationResult }) {
  const catalog = result.catalogReference;
  const catalogUrl = catalog && reliableReferenceUrl(catalog.sourceUrl);
  return (
    <section className="drug-explanation" aria-label="一般藥品解說">
      <h3>{result.queriedProduct.name}</h3>
      <p className="muted">
        查詢標示：
        {[result.queriedProduct.strength, result.queriedProduct.form]
          .filter(Boolean)
          .join("、") || "含量與劑型未提供"}
      </p>
      <Notice>
        {result.identityStatus === "confirmed"
          ? "以下是這次查得的藥品一般資訊，不依你的個人用法推算用量或使用次數。"
          : "產品身分尚未核對。以下依照片辨識或輸入的藥名查詢一般資訊；名稱相近的藥可能有不同成分、濃度與用途，請對照手上包裝。"}
      </Notice>
      {catalog && (
        <details className="card small">
          <summary>查得的官方登記資料</summary>
          <p>名稱對應只供查詢參考，尚未確認手上產品。</p>
          <p>
            <strong>{catalog.nameZh}</strong>
            {catalog.nameEn && <><br />{catalog.nameEn}</>}
          </p>
          <p>
            含量／規格：{catalog.strength || "登記資料未提供"}；劑型：
            {catalog.form || "登記資料未提供"}
          </p>
          <p>登記成分：{catalog.ingredients.join("、") || "登記資料未提供"}</p>
          <p>許可證字號：{catalog.licenseNo}</p>
          {catalogUrl && (
            <a className="text-link" href={catalogUrl} target="_blank" rel="noopener noreferrer">
              開啟食藥署藥品登記資料
            </a>
          )}
        </details>
      )}
      <Evidence result={result} showQuiz={false} />
    </section>
  );
}
