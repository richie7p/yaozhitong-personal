import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api } from "./api";
import { Button, Notice } from "./components";
export function LeafletReview({
  leaflet: l,
  refresh,
}: {
  leaflet: any;
  refresh: () => void;
}) {
  const [checked, setChecked] = useState(false),
    [message, setMessage] = useState(""),
    [text, setText] = useState("");
  return (
    <section className="card">
      <div className="row spread">
        <h3>{l.licenseNo}</h3>
        <span
          className={"tag " + (l.status === "published" ? "green" : "amber")}
        >
          {l.status === "published"
            ? "已發布"
            : l.status === "retired"
              ? "舊版本"
              : "待檢查草稿"}
        </span>
      </div>
      <a href={l.sourceUrl} target="_blank" rel="noreferrer">
        開啟官方原始仿單
      </a>
      <p className="fine">
        版本 {l.version} · {l.chunks.length} 段
      </p>
      <details>
        <summary>檢查抽取文字</summary>
        {l.chunks.map((c: any) => (
          <blockquote key={c.id}>
            第 {c.page} 頁 · {c.text}
          </blockquote>
        ))}
      </details>
      {l.status === "draft" && (
        <>
          <details>
            <summary>修正掃描／抽取文字</summary>
            <p>
              每頁以獨立段落輸入，用「---PAGE---」分隔頁面，依原 PDF 頁序填寫。
            </p>
            <textarea
              aria-label="修正仿單文字"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button
              onClick={async () => {
                try {
                  await api("/admin/leaflets/" + l.id + "/text", "PUT", {
                    pages: text
                      .split("---PAGE---")
                      .map((t, i) => ({ page: i + 1, text: t.trim() })),
                  });
                  setChecked(false);
                  refresh();
                } catch (e: any) {
                  setMessage(e.message);
                }
              }}
            >
              儲存修正文字
            </Button>
          </details>
          <label className="choice">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            我已核對許可證、原 PDF、頁碼與抽取文字
          </label>
          <Button
            className="primary"
            disabled={!checked || !l.chunks.length}
            onClick={async () => {
              try {
                await api("/admin/leaflets/" + l.id + "/publish", "POST", {
                  reviewed: true,
                });
                refresh();
              } catch (e: any) {
                setMessage(e.message);
              }
            }}
          >
            <CheckCircle2 size={16} />
            發布此版本
          </Button>
        </>
      )}
      {message && <Notice error>{message}</Notice>}
    </section>
  );
}
