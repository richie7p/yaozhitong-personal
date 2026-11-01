import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileText,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import type { LeafletPage, LeafletStats } from "../shared/admin";
import type { Leaflet } from "../shared/schema";
import { api, fileBase64 } from "./api";
import { useAuth } from "./auth";
import {
  Button,
  Busy,
  Empty,
  Field,
  Notice,
  SectionTitle,
  useData,
} from "./components";
import { LeafletReview } from "./LeafletReview";
import { SupportInbox } from "./Support";

export const adminSections = [
  ["overview", "管理總覽"],
  ["leaflets", "仿單管理"],
  ["users", "帳號管理"],
  ["usage", "用量與任務"],
  ["support", "問題回報"],
] as const;
const statusLabels: Record<string, string> = {
  published: "已發布",
  draft: "待核對",
  retired: "舊版本",
};

function ReadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="read-error">
      <Notice error>{message}</Notice>
      <Button className="secondary" onClick={retry}>
        <RefreshCw size={16} />
        重新讀取
      </Button>
    </div>
  );
}

export function Admin({ section = "overview" }: { section?: string }) {
  const selected = adminSections.some(([id]) => id === section)
    ? section
    : "overview";
  const stats = useData<LeafletStats>("/admin/leaflets/stats");
  const title = adminSections.find(([id]) => id === selected)![1];
  return (
    <div className="admin-console">
      <SectionTitle eyebrow="管理員工作區" title={title}>
        維護官方來源與服務，讓每一位使用者都能安心閱讀。
      </SectionTitle>
      <nav className="admin-tabs" aria-label="後台功能">
        {adminSections.map(([id, label]) => (
          <a
            key={id}
            href={"#admin?view=" + id}
            aria-current={selected === id ? "page" : undefined}
            className={selected === id ? "active" : ""}
          >
            {label}
          </a>
        ))}
      </nav>
      {stats.error ? (
        <ReadError
          message={"仿單統計讀取失敗。" + stats.error}
          retry={stats.refresh}
        />
      ) : (
        <div
          className="admin-stats"
          aria-label="仿單統計"
          aria-busy={stats.loading}
        >
          {(
            [
              ["published", "已發布仿單", CheckCircle2],
              ["draft", "待核對草稿", FileText],
              ["total", "全部來源版本", BookOpen],
            ] as const
          ).map(([key, label, Icon]) => (
            <div className="admin-stat" key={key}>
              <span className="stat-symbol">
                <Icon size={21} />
              </span>
              <div>
                <span>{label}</span>
                <strong>
                  {stats.loading || !stats.data
                    ? "—"
                    : stats.data[key].toLocaleString("zh-TW")}
                  <small>份</small>
                </strong>
              </div>
            </div>
          ))}
        </div>
      )}
      {selected === "overview" && (
        <>
          <div className="admin-overview-grid">
            <a className="card admin-entry" href="#admin?view=leaflets">
              <BookOpen />
              <h2>整理官方仿單</h2>
              <p>搜尋許可證、檢查草稿，再發布已核對的來源。</p>
              <span>
                前往仿單管理 <ArrowRight size={17} />
              </span>
            </a>
            <a className="card admin-entry" href="#admin?view=support">
              <Users />
              <h2>處理使用者回報</h2>
              <p>查看網站問題，回覆會保留在使用者的私密回報頁。</p>
              <span>
                查看回報 <ArrowRight size={17} />
              </span>
            </a>
          </div>
          <div className="admin-role-note">
            <ShieldCheck size={22} />
            <div>
              <strong>兩種身分，清楚分工</strong>
              <p>
                大眾註冊後皆為一般使用者。只有已授權的管理員能進入後台；管理員也可從側欄切回自己的用藥紀錄。
              </p>
            </div>
          </div>
        </>
      )}
      {selected === "leaflets" && (
        <LeafletLibrary refreshStats={stats.refresh} />
      )}
      {selected === "users" && <AccountManagement />}
      {selected === "usage" && <Usage />}
      {selected === "support" && <SupportInbox />}
    </div>
  );
}

function LeafletLibrary({
  refreshStats,
}: {
  refreshStats: () => Promise<void>;
}) {
  const [draftLicense, setDraftLicense] = useState("");
  const [licenseNo, setLicenseNo] = useState("");
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState([""]);
  const [selected, setSelected] = useState<string | null>(null);
  const query = new URLSearchParams({ limit: "20" });
  if (licenseNo) query.set("licenseNo", licenseNo);
  if (status) query.set("status", status);
  if (cursors.at(-1)) query.set("cursor", cursors.at(-1)!);
  const list = useData<LeafletPage>("/admin/leaflets?" + query.toString());
  const refresh = async () => {
    await Promise.all([list.refresh(), refreshStats()]);
  };
  if (selected)
    return (
      <LeafletDetail
        key={selected}
        id={selected}
        back={() => setSelected(null)}
        changed={refresh}
      />
    );
  return (
    <>
      <section className="card leaflet-library">
        <div className="row spread">
          <div>
            <h2>官方仿單清單</h2>
            <p className="muted">
              每頁 20 份。選擇一份仿單，再查看原文與版本資料。
            </p>
          </div>
          <Button className="secondary" onClick={refresh}>
            <RefreshCw size={16} />
            更新清單
          </Button>
        </div>
        <form
          className="library-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setLicenseNo(draftLicense.trim());
            setCursors([""]);
          }}
        >
          <Field label="搜尋許可證字號">
            <input
              value={draftLicense}
              onChange={(e) => setDraftLicense(e.target.value)}
              placeholder="輸入完整許可證字號"
              maxLength={80}
            />
          </Field>
          <Field label="發布狀態">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursors([""]);
              }}
            >
              <option value="">全部狀態</option>
              <option value="published">已發布</option>
              <option value="draft">待核對草稿</option>
              <option value="retired">舊版本</option>
            </select>
          </Field>
          <Button type="submit" className="primary">
            <Search size={17} />
            搜尋
          </Button>
          {licenseNo && (
            <Button
              className="secondary"
              onClick={() => {
                setDraftLicense("");
                setLicenseNo("");
                setCursors([""]);
              }}
            >
              清除搜尋
            </Button>
          )}
        </form>
        {list.loading ? (
          <Busy text="正在讀取仿單清單…" />
        ) : list.error ? (
          <ReadError
            message={"仿單清單讀取失敗。" + list.error}
            retry={list.refresh}
          />
        ) : !list.data?.items.length ? (
          <Empty title="目前沒有符合條件的仿單">
            試試其他許可證字號，或切換發布狀態。
          </Empty>
        ) : (
          <>
            <div className="leaflet-list">
              {list.data.items.map((row) => (
                <article className="leaflet-summary" key={row.id}>
                  <span className="leaflet-symbol">
                    <FileText size={24} />
                  </span>
                  <div className="grow">
                    <h3>{row.licenseNo}</h3>
                    <p>
                      版本 {row.version}
                      {row.checkedAt
                        ? " · 核對 " +
                          new Date(row.checkedAt).toLocaleDateString("zh-TW", {
                            timeZone: "Asia/Taipei",
                          })
                        : " · 等待核對"}
                    </p>
                  </div>
                  <span
                    className={
                      "tag " + (row.status === "published" ? "green" : "amber")
                    }
                  >
                    {statusLabels[row.status] || row.status}
                  </span>
                  <button
                    className="btn secondary"
                    onClick={() => setSelected(row.id)}
                    aria-label={"查看仿單 " + row.licenseNo}
                  >
                    查看內容
                    <ArrowRight size={16} />
                  </button>
                </article>
              ))}
            </div>
            <div className="pagination" aria-label="仿單分頁">
              <Button
                className="secondary"
                disabled={cursors.length === 1}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                <ArrowLeft size={16} />
                上一頁
              </Button>
              <span role="status">
                第 {cursors.length} 頁 · 本頁 {list.data.items.length} 份
              </span>
              <Button
                className="secondary"
                disabled={!list.data.nextCursor}
                onClick={() => {
                  if (list.data?.nextCursor)
                    setCursors([...cursors, list.data.nextCursor]);
                }}
              >
                下一頁
                <ArrowRight size={16} />
              </Button>
            </div>
          </>
        )}
      </section>
      <LeafletUpload done={refresh} />
    </>
  );
}

function LeafletDetail({
  id,
  back,
  changed,
}: {
  id: string;
  back: () => void;
  changed: () => Promise<void>;
}) {
  const detail = useData<Leaflet>("/admin/leaflets/" + encodeURIComponent(id));
  return (
    <div className="leaflet-detail">
      <Button className="secondary" onClick={back}>
        <ArrowLeft size={16} />
        返回仿單清單
      </Button>
      {detail.loading ? (
        <Busy text="正在讀取這份仿單…" />
      ) : detail.error ? (
        <ReadError message={detail.error} retry={detail.refresh} />
      ) : (
        detail.data && (
          <LeafletReview
            leaflet={detail.data}
            refresh={async () => {
              await detail.refresh();
              await changed();
            }}
          />
        )
      )}
    </div>
  );
}

function LeafletUpload({ done }: { done: () => Promise<void> }) {
  const [license, setLicense] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(false);
  return (
    <details className="card import-panel">
      <summary>
        <Upload size={19} />
        新增官方仿單草稿
      </summary>
      <p className="muted">
        先匯入，再對照原始文件核對。草稿不會直接提供給一般使用者。
      </p>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file || busy) return;
          setBusy(true);
          setMessage("");
          try {
            await api("/admin/leaflets", "POST", {
              licenseNo: license,
              sourceUrl: url,
              pdf: await fileBase64(file),
            });
            setError(false);
            setMessage("草稿已匯入，請在「待核對草稿」查看並核對內容。");
            await done();
          } catch (e: any) {
            setError(true);
            setMessage(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="許可證字號">
          <input
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            required
            maxLength={80}
          />
        </Field>
        <Field label="食藥署官方原始網址">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            placeholder="https://…fda.gov.tw/…"
          />
        </Field>
        <Field label="仿單 PDF">
          <input
            type="file"
            accept="application/pdf"
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </Field>
        <div>
          <Button type="submit" className="primary" disabled={busy}>
            {busy ? "正在匯入…" : "匯入草稿"}
          </Button>
        </div>
      </form>
      {message && <Notice error={error}>{message}</Notice>}
    </details>
  );
}

function AccountManagement() {
  const { me, config } = useAuth();
  const users = useData("/admin/users");
  const [q, setQ] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState("");
  const items =
    users.data?.items.filter((u: any) =>
      (u.email + " " + u.displayName).toLowerCase().includes(q.toLowerCase()),
    ) || [];
  async function change(u: any, patch: object) {
    setBusy(u.id);
    setMessage("");
    try {
      await api("/admin/users/" + u.id, "PATCH", patch);
      await users.refresh();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="card">
      <h2>帳號與身分</h2>
      <p className="muted">
        新帳號預設為一般使用者；身分權限由系統驗證，不能自行切換成管理員。
      </p>
      <Field label="搜尋帳號">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="顯示名稱或 Email"
        />
      </Field>
      {message && <Notice error>{message}</Notice>}
      {users.loading ? (
        <Busy />
      ) : users.error ? (
        <ReadError message={users.error} retry={users.refresh} />
      ) : !items.length ? (
        <Empty title="沒有符合的帳號">請調整搜尋條件。</Empty>
      ) : (
        items.map((u: any) => (
          <div className="list-row account-row" key={u.id}>
            <span className="account-avatar">{u.displayName?.[0] || "人"}</span>
            <div className="grow">
              <strong>{u.displayName || "未設定名稱"}</strong>
              <small>{u.email}</small>
            </div>
            <span className={"tag " + (u.admin ? "green" : "")}>
              {u.admin ? "管理員" : "一般使用者"}
            </span>
            {u.disabled && <span className="tag amber">已停用</span>}
            {u.id !== me.account.id && (
              <>
                <Button
                  disabled={!!busy}
                  className="secondary"
                  onClick={() => change(u, { disabled: !u.disabled })}
                >
                  {u.disabled ? "恢復帳號" : "停用帳號"}
                </Button>
                {config.publicAccess !== "verified" && (
                  <Button
                    disabled={!!busy}
                    onClick={() => change(u, { eligible: !u.eligible })}
                  >
                    {u.eligible ? "取消資格" : "開通測試"}
                  </Button>
                )}
              </>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function Usage() {
  const usage = useData("/admin/usage");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState("");
  if (usage.loading) return <Busy />;
  if (usage.error)
    return <ReadError message={usage.error} retry={usage.refresh} />;
  const labels: Record<string, string> = {
    recognition: "藥袋辨識",
    bundle: "說明與測驗",
    chat: "用藥問答",
    interaction: "交互作用比對",
    succeeded: "已完成",
    queued: "等待處理",
    running: "處理中",
    failed: "處理失敗",
  };
  return (
    <>
      <section className="card">
        <div className="row spread">
          <div>
            <h2>背景任務</h2>
            <p className="muted">
              藥名索引{" "}
              {Number(usage.data?.catalog?.count || 0).toLocaleString("zh-TW")}{" "}
              筆 · 已記錄 {usage.data?.jobs.length || 0} 次任務
            </p>
          </div>
          <Button className="secondary" onClick={usage.refresh}>
            重新整理
          </Button>
        </div>
        {message && <Notice error>{message}</Notice>}
        {[...(usage.data?.jobs || [])]
          .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))
          .map((j: any) => (
            <div className="list-row" key={j.id}>
              <strong>{labels[j.kind] || j.kind}</strong>
              <span className="grow">
                {labels[j.status] || j.status}
                {j.errorCode ? " · " + j.errorCode : ""}
              </span>
              <small>
                {new Date(j.createdAt).toLocaleString("zh-TW", {
                  timeZone: "Asia/Taipei",
                })}
              </small>
              {j.status === "failed" && j.kind !== "recognition" && (
                <Button
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(j.id);
                    try {
                      await api("/admin/jobs/" + j.id + "/retry", "POST", {});
                      await usage.refresh();
                    } catch (e: any) {
                      setMessage(e.message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  重試
                </Button>
              )}
            </div>
          ))}
        {!usage.data?.jobs.length && (
          <Empty title="目前沒有處理任務">
            使用者開始辨識或閱讀後，任務狀態會出現在這裡。
          </Empty>
        )}
      </section>
      <section className="card">
        <h2>每日 AI 請求量</h2>
        {usage.data?.items
          .filter((u: any) => u.id.startsWith("global-"))
          .map((u: any) => (
            <div className="list-row" key={u.id}>
              <strong>{u.date}</strong>
              <span>{u.count} 次</span>
            </div>
          ))}
      </section>
    </>
  );
}
