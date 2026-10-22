import { useRef, useState } from "react";
import { useAuth } from "./auth";
import { api } from "./api";
import {
  Button,
  Busy,
  Field,
  Notice,
  SectionTitle,
  useData,
} from "./components";
const categories: Record<string, string> = {
  bug: "功能異常",
  account: "帳號問題",
  privacy: "資料與隱私",
  other: "其他建議",
};
export function SupportPage() {
  const auth = useAuth();
  return (
    <main className="public-info" id="main">
      <a className="brand" href="#home">
        <img src="/icon.svg" alt="" />
        <div>
          藥智通<small>回到用藥手帳</small>
        </div>
      </a>
      <SectionTitle eyebrow="一起改善服務" title="問題回報">
        回報只提供給你與管理員查看；回覆會出現在此頁。
      </SectionTitle>
      <p>
        這個表單處理網站與資料問題，不提供即時醫療諮詢。請勿填寫身分證字號、住址、密碼、完整病歷或其他人的個資。
      </p>
      {auth.loading ? (
        <Busy />
      ) : auth.me ? (
        <SupportForm key={auth.me.account.id} />
      ) : (
        <section className="card">
          <h2>登入後提交私密回報</h2>
          <p>
            登入遇到問題時，可先使用登入頁的「忘記密碼？」或 Google
            登入。完成登入後，從選單「問題回報」回到這裡。
          </p>
          <a className="btn primary" href="#home">
            前往登入／註冊
          </a>
        </section>
      )}
      <a className="text-link" href="#privacy">
        資料使用與隱私
      </a>
    </main>
  );
}
function SupportForm() {
  const { emailVerified } = useAuth();
  const [cursor, setCursor] = useState("");
  const rows = useData(
    "/support" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
  );
  const [category, setCategory] = useState("bug"),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(false);
  const key = useRef({ payload: "", value: "" });
  return (
    <>
      {!emailVerified && (
        <Notice>請到「帳號與設定」完成信箱驗證後提交回報。</Notice>
      )}
      <form
        className="card stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !emailVerified) return;
          const payload = JSON.stringify({ category, message: text.trim() });
          if (key.current.payload !== payload)
            key.current = { payload, value: crypto.randomUUID() };
          setBusy(true);
          setMessage("");
          try {
            await api(
              "/support",
              "POST",
              JSON.parse(payload),
              key.current.value,
            );
            setText("");
            key.current = { payload: "", value: "" };
            setError(false);
            setMessage("回報已送出，管理員回覆會顯示在下方。");
            if (cursor) setCursor("");
            else await rows.refresh();
          } catch (e: any) {
            setError(true);
            setMessage(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="問題類型">
          <select
            value={category}
            disabled={busy}
            onChange={(e) => setCategory(e.target.value)}
          >
            {Object.entries(categories).map(([id, label]) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="問題描述">
          <textarea
            value={text}
            disabled={busy}
            required
            minLength={10}
            maxLength={1200}
            rows={5}
            onChange={(e) => setText(e.target.value)}
            placeholder="請描述操作步驟、預期結果與實際畫面，不要貼上私人用藥內容。"
          />
        </Field>
        <small>
          {text.length} / 1200 字；每天最多 5 則，送出間隔至少 1 分鐘。
        </small>
        <Button
          type="submit"
          className="primary"
          disabled={busy || !emailVerified}
        >
          {busy ? "正在送出…" : "送出私密回報"}
        </Button>
      </form>
      {message && <Notice error={error}>{message}</Notice>}
      <section className="card">
        <div className="row spread">
          <h2>我的回報</h2>
          <Button
            onClick={() => {
              void rows.refresh();
            }}
          >
            更新回覆
          </Button>
        </div>
        {rows.loading && <Busy />}
        {rows.error && <Notice error>{rows.error}</Notice>}
        {rows.data?.items.length === 0 && <p>目前沒有回報。</p>}
        {rows.data?.items.map((row: any) => (
          <article className="card" key={row.id}>
            <strong>
              {categories[row.category]} ·{" "}
              {row.status === "resolved" ? "已處理" : "處理中"}
            </strong>
            <small>{new Date(row.createdAt).toLocaleString("zh-TW")}</small>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {row.message}
            </p>
            {row.replies.map((reply: any, i: number) => (
              <blockquote key={i}>
                <strong>管理員回覆</strong>
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {reply.message}
                </p>
                <small>{new Date(reply.at).toLocaleString("zh-TW")}</small>
              </blockquote>
            ))}
          </article>
        ))}
        <SupportPages
          cursor={cursor}
          next={rows.data?.nextCursor}
          change={setCursor}
        />
      </section>
    </>
  );
}
function SupportPages({
  cursor,
  next,
  change,
}: {
  cursor: string;
  next?: string;
  change: (value: string) => void;
}) {
  return (
    <div className="row">
      {cursor && <Button onClick={() => change("")}>回最新回報</Button>}
      {next && <Button onClick={() => change(next)}>更早的回報</Button>}
    </div>
  );
}
export function SupportInbox() {
  const [cursor, setCursor] = useState("");
  const rows = useData(
    "/admin/support" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
  );
  return (
    <section className="card">
      <div className="row spread">
        <h2>私密問題回報</h2>
        <Button
          onClick={() => {
            void rows.refresh();
          }}
        >
          更新回報
        </Button>
      </div>
      <p>
        每頁顯示 50
        則回報。內容由使用者自行提交；不會附帶其藥袋、病歷或提問紀錄。
      </p>
      {rows.loading && <Busy />}
      {rows.error && <Notice error>{rows.error}</Notice>}
      {rows.data?.items.map((row: any) => (
        <SupportReply
          key={row.id + row.updatedAt}
          row={row}
          refresh={rows.refresh}
        />
      ))}
      {rows.data?.items.length === 0 && <p>目前沒有回報。</p>}
      <SupportPages
        cursor={cursor}
        next={rows.data?.nextCursor}
        change={setCursor}
      />
    </section>
  );
}
function SupportReply({
  row,
  refresh,
}: {
  row: any;
  refresh: () => Promise<void>;
}) {
  const replyKey = useRef({ payload: "", value: "" });
  const [text, setText] = useState(""),
    [status, setStatus] = useState(row.status),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <article className="card">
      <h3>
        {categories[row.category]} ·{" "}
        {row.status === "resolved" ? "已處理" : "處理中"}
      </h3>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {row.message}
      </p>
      {row.replies.map((reply: any, i: number) => (
        <blockquote key={i}>{reply.message}</blockquote>
      ))}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const payload = JSON.stringify({ message: text.trim(), status });
            if (replyKey.current.payload !== payload)
              replyKey.current = { payload, value: crypto.randomUUID() };
            await api(
              "/admin/support/" + row.id,
              "PATCH",
              JSON.parse(payload),
              replyKey.current.value,
            );
            await refresh();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="管理員回覆">
          <textarea
            value={text}
            required
            maxLength={1200}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field label="處理狀態">
          <select
            value={status}
            disabled={busy}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="open">處理中</option>
            <option value="resolved">已處理</option>
          </select>
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "正在儲存…" : "送出回覆"}
        </Button>
        {error && <Notice error>{error}</Notice>}
      </form>
    </article>
  );
}
