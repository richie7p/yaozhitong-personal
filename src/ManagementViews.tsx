import { useEffect, useState } from "react";
import {
  Users,
  Copy,
  Plus,
  Bell,
  Download,
  ShieldCheck,
  Search,
  Upload,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { api, fileBase64 } from "./api";
import { useAuth } from "./auth";
import { JobHistory } from "./JobHistory";
import {
  Button,
  Busy,
  Empty,
  Field,
  Notice,
  SectionTitle,
  useData,
} from "./components";
export function Care() {
  const { data, error, loading, refresh } = useData("/care");
  useEffect(() => {
    const update = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(update, 30000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, []);
  const [invite, setInvite] = useState<any>(null),
    [code, setCode] = useState(""),
    [snapshot, setSnapshot] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const s = await api("/care/" + selected + "/snapshot");
        if (live) {
          setSnapshot(s);
          setMessage("");
        }
      } catch (e: any) {
        if (live) {
          setSnapshot(null);
          setMessage(e.message);
        }
      }
    };
    load();
    const timer = setInterval(load, 30000);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [selected]);
  return (
    <>
      <SectionTitle eyebrow="CARE, TOGETHER" title="家人照護">
        把關心連起來。由你決定分享給誰，也能隨時取消。
      </SectionTitle>
      {(error || message) && <Notice error>{error || message}</Notice>}
      <div className="two-col">
        <section className="card">
          <div className="circle-icon">
            <Users size={25} />
          </div>
          <h2>邀請家人關心我</h2>
          <p>
            分享藥品、排程與服藥紀錄。家人不能修改資料，也看不到私人問答和完整健康問卷。
          </p>
          <Button
            className="primary"
            onClick={async () => {
              try {
                setInvite(await api("/care/invites", "POST", {}));
              } catch (e: any) {
                setMessage(e.message);
              }
            }}
          >
            產生邀請碼
          </Button>
          {invite && (
            <div className="invite-code">
              <code>{invite.code}</code>
              <button
                aria-label="複製邀請碼"
                className="icon-button"
                onClick={() => navigator.clipboard.writeText(invite.code)}
              >
                <Copy size={18} />
              </button>
              <small>
                一次性使用，有效 24 小時。請直接提供給你信任的家人。
              </small>
            </div>
          )}
        </section>
        <section className="card">
          <h2>我想照顧家人</h2>
          <p>輸入家人提供的邀請碼，查看對方授權分享的資訊。</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/care/accept", "POST", { code });
                setCode("");
                refresh();
              } catch (e: any) {
                setMessage(e.message);
              }
            }}
          >
            <Field label="邀請碼">
              <input
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="輸入家人的邀請碼"
                autoCapitalize="characters"
              />
            </Field>
            <Button type="submit" className="secondary">
              接受邀請
            </Button>
          </form>
        </section>
      </div>
      <section className="card">
        <h2>照護連結</h2>
        {loading ? (
          <Busy />
        ) : !data?.items.length ? (
          <Empty title="還沒有照護連結">
            邀請家人，或接受家人的邀請，讓彼此的關心更靠近。
          </Empty>
        ) : (
          data.items.map((r: any) => (
            <div className="list-row" key={r.id}>
              <div className="avatar">{r.displayName[0]}</div>
              <div className="grow">
                <strong>{r.displayName}</strong>
                <small>
                  {r.direction === "shared"
                    ? "對方可以查看我的用藥"
                    : "我可以查看對方的用藥"}
                </small>
              </div>
              {r.direction === "shared" ? (
                <Button
                  onClick={async () => {
                    if (confirm("取消後，對方將無法再讀取你的用藥資料。")) {
                      await api("/care/" + r.id, "DELETE");
                      refresh();
                    }
                  }}
                >
                  取消授權
                </Button>
              ) : (
                <Button
                  className="secondary"
                  onClick={() => setSelected(r.ownerId)}
                >
                  查看紀錄
                </Button>
              )}
            </div>
          ))
        )}
      </section>
      {snapshot && (
        <section className="card">
          <h2>{snapshot.displayName}的用藥紀錄</h2>
          <p className="muted">
            更新於 {new Date(snapshot.updatedAt).toLocaleString("zh-TW")} · 每
            30 秒更新
          </p>
          {snapshot.today.length === 0 && <p>今天沒有排程。</p>}
          {snapshot.today.map((r: any) => (
            <div className="list-row" key={r.id}>
              <strong>{r.time}</strong>
              <span className="grow">{r.name}</span>
              <span className="tag">
                {r.log
                  ? r.log.status === "taken"
                    ? "已記錄服用"
                    : "已略過"
                  : "尚未記錄"}
              </span>
            </div>
          ))}
          <h3>近期紀錄</h3>
          {snapshot.logs.map((r: any) => (
            <div className="list-row" key={r.id}>
              <span>{r.name}</span>
              <span>{r.status === "taken" ? "已記錄服用" : "略過"}</span>
              <small>{new Date(r.recordedAt).toLocaleString("zh-TW")}</small>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
export function Cabinet() {
  const { data, refresh, error } = useData("/cabinet");
  const [edit, setEdit] = useState<any>(null),
    [message, setMessage] = useState("");
  return (
    <>
      <SectionTitle
        eyebrow="HOME MEDICINE CABINET"
        title="家庭藥箱"
        action={
          <Button
            className="primary"
            onClick={() =>
              setEdit({
                name: "",
                quantity: 0,
                unit: "",
                expiresAt: "",
                disposed: false,
              })
            }
          >
            <Plus size={18} />
            新增藥箱項目
          </Button>
        }
      >
        整理存量、留意效期，讓家裡的藥品保持清楚。
      </SectionTitle>
      {(error || message) && <Notice error>{error || message}</Notice>}
      {edit && (
        <section className="card">
          <form
            className="form-grid"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(
                  "/cabinet" + (edit.id ? "/" + edit.id : ""),
                  edit.id ? "PUT" : "POST",
                  { ...edit, expiresAt: edit.expiresAt || null },
                );
                setEdit(null);
                refresh();
              } catch (e: any) {
                setMessage(e.message);
              }
            }}
          >
            <Field label="名稱">
              <input
                required
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="剩餘數量">
              <input
                required
                type="number"
                min="0"
                step="any"
                value={edit.quantity}
                onChange={(e) =>
                  setEdit({ ...edit, quantity: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="單位">
              <input
                required
                value={edit.unit}
                onChange={(e) => setEdit({ ...edit, unit: e.target.value })}
              />
            </Field>
            <Field label="有效日期">
              <input
                type="date"
                value={edit.expiresAt || ""}
                onChange={(e) =>
                  setEdit({ ...edit, expiresAt: e.target.value })
                }
              />
            </Field>
            <div className="full-grid">
              <Button type="submit" className="primary">
                儲存
              </Button>{" "}
              <Button onClick={() => setEdit(null)}>取消</Button>
            </div>
          </form>
        </section>
      )}
      <section className="card">
        {!data?.items.length ? (
          <Empty title="藥箱整理，從盤點開始">
            記下名稱、存量與有效日期，之後隨時更新。
          </Empty>
        ) : (
          data.items.map((r: any) => (
            <div className="list-row" key={r.id}>
              <div className="grow">
                <strong>{r.name}</strong>
                <small>
                  {r.quantity} {r.unit} ·{" "}
                  {r.expiresAt ? "有效至 " + r.expiresAt : "尚未填寫效期"}
                </small>
              </div>
              <span
                className={
                  "tag " +
                  (!r.disposed &&
                  r.expiresAt &&
                  r.expiresAt < new Date().toISOString().slice(0, 10)
                    ? "amber"
                    : "")
                }
              >
                {r.disposed
                  ? "已處理"
                  : r.expiresAt &&
                      r.expiresAt < new Date().toISOString().slice(0, 10)
                    ? "已過期"
                    : "保存中"}
              </span>
              <Button onClick={() => setEdit(r)}>編輯</Button>
              {!r.disposed && (
                <Button
                  onClick={async () => {
                    await api("/cabinet/" + r.id, "PUT", {
                      ...r,
                      disposed: true,
                    });
                    refresh();
                  }}
                >
                  標記已處理
                </Button>
              )}
            </div>
          ))
        )}
      </section>
      <Notice>
        不確定藥品保存或處理方式時，請攜帶藥品向藥師詢問。
        <a href="https://www.fda.gov.tw/" target="_blank" rel="noreferrer">
          食藥署資訊
        </a>
      </Notice>
    </>
  );
}
export function History() {
  const { data, loading, error, refresh } = useData("/dose-logs");
  const [message, setMessage] = useState("");
  return (
    <>
      <SectionTitle eyebrow="MEDICATION JOURNAL" title="服藥紀錄">
        每一筆都是你的紀錄。尚未打卡，不代表尚未服藥。
      </SectionTitle>
      {(error || message) && <Notice error>{error || message}</Notice>}
      <section className="card">
        {loading ? (
          <Busy />
        ) : !data?.items.length ? (
          <Empty title="還沒有服藥紀錄">
            在今日總覽記錄定時服用，或從藥品清單記錄需要時服用。
          </Empty>
        ) : (
          data.items.map((r: any) => (
            <div className="list-row" key={r.id}>
              <div className="grow">
                <strong>{r.name}</strong>
                <small>
                  {new Date(r.dueAt || r.recordedAt).toLocaleString("zh-TW")}
                </small>
              </div>
              <span className={"tag " + (r.status === "taken" ? "green" : "")}>
                {r.status === "taken" ? "已記錄服用" : "已略過"}
              </span>
              <Button
                onClick={async () => {
                  try {
                    await api("/dose-logs/" + r.id, "PATCH", {
                      status: r.status === "taken" ? "skipped" : "taken",
                      note: "使用者更正紀錄",
                    });
                    refresh();
                  } catch (e: any) {
                    setMessage(e.message);
                  }
                }}
              >
                更正
              </Button>
            </div>
          ))
        )}
      </section>
    </>
  );
}
export function Profile() {
  const auth = useAuth();
  const [p, setP] = useState<any>({
      ...{
        displayName: auth.me.account.displayName,
        age: null,
        sex: "unspecified",
        conditions: [],
        allergies: "",
        pregnancy: "unknown",
        notes: "",
        notifyFamily: false,
        timezone: "Asia/Taipei",
      },
      ...auth.me.profile,
    }),
    [message, setMessage] = useState(""),
    [password, setPassword] = useState(""),
    [linkEmail, setLinkEmail] = useState(auth.me.account.email || "");
  const set = (key: string, v: any) => setP({ ...p, [key]: v });
  async function action(fn: () => Promise<unknown>, success: string) {
    try {
      await fn();
      setMessage(success);
    } catch (e: any) {
      setMessage(e.message);
    }
  }
  return (
    <>
      <SectionTitle eyebrow="YOUR ACCOUNT" title="帳號與設定">
        由你管理自己的資料、照護分享與通知。
      </SectionTitle>
      {message && <Notice>{message}</Notice>}
      <div className="two-col">
        <section className="card">
          <h2>個人健康資料</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                await api("/me", "PUT", p);
                await auth.reload();
              }, "個人資料已更新。");
            }}
          >
            <Field label="顯示名稱">
              <input
                required
                maxLength={60}
                value={p.displayName}
                onChange={(e) => set("displayName", e.target.value)}
              />
            </Field>
            <div className="two-col">
              <Field label="年齡（可留白）">
                <input
                  type="number"
                  min="0"
                  max="120"
                  value={p.age ?? ""}
                  onChange={(e) =>
                    set("age", e.target.value ? Number(e.target.value) : null)
                  }
                />
              </Field>
              <Field label="生理性別">
                <select
                  value={p.sex}
                  onChange={(e) => set("sex", e.target.value)}
                >
                  <option value="unspecified">未提供</option>
                  <option value="female">女性</option>
                  <option value="male">男性</option>
                </select>
              </Field>
            </div>
            <Field label="健康狀況（逗號分隔）">
              <input
                value={p.conditions.join(",")}
                onChange={(e) =>
                  set(
                    "conditions",
                    e.target.value.split(/[,，]/).filter(Boolean),
                  )
                }
                placeholder="例如：高血壓、糖尿病"
              />
            </Field>
            <Field label="過敏資訊">
              <input
                value={p.allergies}
                onChange={(e) => set("allergies", e.target.value)}
              />
            </Field>
            <Field label="懷孕／哺乳狀況">
              <select
                value={p.pregnancy}
                onChange={(e) => set("pregnancy", e.target.value)}
              >
                <option value="unknown">未提供</option>
                <option value="no">無／不適用</option>
                <option value="pregnant">懷孕中</option>
                <option value="lactating">哺乳中</option>
              </select>
            </Field>
            <Field label="其他健康補充">
              <textarea
                maxLength={1000}
                value={p.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="請勿填寫身分證字號、地址等識別資料"
              />
            </Field>
            <label className="choice">
              <input
                type="checkbox"
                checked={p.notifyFamily}
                onChange={(e) => set("notifyFamily", e.target.checked)}
              />
              到期 60 分鐘仍未記錄時，通知已授權家人
            </label>
            <Button className="primary" type="submit">
              儲存設定
            </Button>
          </form>
        </section>
        <div>
          <section className="card">
            <h2>登入與通知</h2>
            <p>{auth.me.account.email}</p>
            <span className="tag">
              {auth.me.account.eligible
                ? "已取得測試資格"
                : "尚待管理員開通 AI 測試資格"}
            </span>
            <div className="stack">
              <Button
                className="secondary"
                onClick={() => action(auth.notify, "已啟用這台裝置的推播。")}
              >
                <Bell size={17} />
                啟用網頁推播
              </Button>
              <Button
                onClick={() =>
                  action(
                    auth.verify,
                    "已更新驗證狀態；若尚未驗證，請查看信箱。",
                  )
                }
              >
                驗證信箱／更新驗證狀態
              </Button>
              {auth.config.mode !== "local" && (
                <>
                  <Button
                    onClick={() =>
                      action(() => auth.link("google"), "已連結 Google 登入。")
                    }
                  >
                    連結 Google 登入
                  </Button>
                  <Field label="要連結的 Email">
                    <input
                      type="email"
                      value={linkEmail}
                      onChange={(e) => setLinkEmail(e.target.value)}
                      autoComplete="email"
                    />
                  </Field>
                  <Field label="為此帳號新增密碼登入">
                    <input
                      type="password"
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="新密碼"
                    />
                  </Field>
                  <Button
                    onClick={() =>
                      action(
                        () => auth.link("password", password, linkEmail),
                        "已連結密碼登入。",
                      )
                    }
                  >
                    連結 Email 密碼
                  </Button>
                </>
              )}
            </div>
            <p className="fine">
              網頁推播受瀏覽器、網路及系統設定影響，不保證像原生鬧鐘般準時。時區：台北。
            </p>
          </section>
          <section className="card">
            <h2>你的資料，由你掌握</h2>
            <Button
              onClick={() =>
                action(async () => {
                  const value = await api("/me/export");
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(value, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "yaozhitong-export.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }, "已匯出資料。")
              }
            >
              <Download size={17} />
              匯出我的資料
            </Button>
            <p className="fine">匯出檔包含私人健康資訊，請妥善保管。</p>
            <Button
              className="danger"
              onClick={() => {
                if (
                  confirm(
                    "刪除帳號會立即停止存取，並清除個人資料與照護關係。確定刪除？",
                  )
                )
                  action(async () => {
                    await api("/me", "DELETE");
                    await auth.logout();
                  }, "帳號已停用並開始清除。");
              }}
            >
              <Trash2 size={16} />
              刪除帳號
            </Button>
          </section>
        </div>
      </div>
      <JobHistory />
    </>
  );
}
export function Admin() {
  const [tab, setTab] = useState("users"),
    [message, setMessage] = useState("");
  const users = useData("/admin/users"),
    leaflets = useData("/admin/leaflets"),
    usage = useData("/admin/usage");
  const [q, setQ] = useState(""),
    [lic, setLic] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <>
      <SectionTitle eyebrow="ADMINISTRATION" title="管理員後台">
        管理帳號、來源資料與服務狀態。私人健康內容不在後台顯示。
      </SectionTitle>
      <div className="tabs">
        {[
          ["users", "帳號管理"],
          ["leaflets", "仿單管理"],
          ["usage", "用量與任務"],
        ].map(([id, t]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {t}
          </button>
        ))}
      </div>
      {message && <Notice>{message}</Notice>}
      {tab === "users" && (
        <section className="card">
          <Field label="搜尋帳號">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="顯示名稱或 Email"
            />
          </Field>
          {users.data?.items
            .filter((u: any) =>
              (u.email + " " + u.displayName)
                .toLowerCase()
                .includes(q.toLowerCase()),
            )
            .map((u: any) => (
              <div className="list-row" key={u.id}>
                <div className="grow">
                  <strong>{u.displayName}</strong>
                  <small>{u.email}</small>
                </div>
                <span className="tag">
                  {u.disabled ? "停用" : u.admin ? "管理員" : "使用者"}
                </span>
                <Button
                  onClick={async () => {
                    try {
                      await api("/admin/users/" + u.id, "PATCH", {
                        eligible: !u.eligible,
                      });
                      users.refresh();
                    } catch (e: any) {
                      setMessage(e.message);
                    }
                  }}
                >
                  {u.eligible ? "取消資格" : "開通測試"}
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await api("/admin/users/" + u.id, "PATCH", {
                        disabled: !u.disabled,
                      });
                      users.refresh();
                    } catch (e: any) {
                      setMessage(e.message);
                    }
                  }}
                >
                  {u.disabled ? "恢復" : "停用"}
                </Button>
              </div>
            ))}
        </section>
      )}
      {tab === "leaflets" && (
        <>
          <section className="card">
            <h2>新增官方仿單</h2>
            <form
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!file) return;
                setBusy(true);
                try {
                  await api("/admin/leaflets", "POST", {
                    licenseNo: lic,
                    sourceUrl: url,
                    pdf: await fileBase64(file),
                  });
                  setMessage("已匯入草稿，請核對原文再發布。");
                  leaflets.refresh();
                } catch (e: any) {
                  setMessage(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="許可證字號">
                <input
                  required
                  value={lic}
                  onChange={(e) => setLic(e.target.value)}
                />
              </Field>
              <Field label="食藥署官方原始網址">
                <input
                  required
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…fda.gov.tw/…"
                />
              </Field>
              <Field label="仿單 PDF">
                <input
                  required
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </Field>
              <div>
                <Button type="submit" className="primary" disabled={busy}>
                  <Upload size={16} />
                  {busy ? "正在抽取文字…" : "匯入草稿"}
                </Button>
              </div>
            </form>
          </section>
          {leaflets.data?.items.map((l: any) => (
            <LeafletReview key={l.id} leaflet={l} refresh={leaflets.refresh} />
          ))}
        </>
      )}
      {tab === "usage" && (
        <>
          <div className="stats">
            <div>
              <span>藥名索引</span>
              <strong>
                {usage.data?.catalog?.count || 0}
                <small>筆</small>
              </strong>
            </div>
            <div>
              <span>已發布仿單</span>
              <strong>
                {leaflets.data?.items.filter(
                  (l: any) => l.status === "published",
                ).length || 0}
                <small>份</small>
              </strong>
            </div>
            <div>
              <span>AI 任務</span>
              <strong>
                {usage.data?.jobs.length || 0}
                <small>次</small>
              </strong>
            </div>
          </div>
          <section className="card">
            <h2>背景任務</h2>
            {usage.data?.jobs.map((j: any) => (
              <div className="list-row" key={j.id}>
                <strong>{j.kind}</strong>
                <span className="grow">
                  {j.status} {j.errorCode || ""} · {j.tokens || 0} tokens{" "}
                  {j.latencyMs != null
                    ? `· ${(j.latencyMs / 1000).toFixed(1)} 秒`
                    : ""}
                </span>
                <small>{new Date(j.createdAt).toLocaleString("zh-TW")}</small>
                {j.status === "failed" && j.kind !== "recognition" && (
                  <Button
                    onClick={async () => {
                      try {
                        await api("/admin/jobs/" + j.id + "/retry", "POST", {});
                        setMessage("已排入重試。");
                        usage.refresh();
                      } catch (e: any) {
                        setMessage(e.message);
                      }
                    }}
                  >
                    重試
                  </Button>
                )}
              </div>
            ))}
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
      )}
    </>
  );
}
function LeafletReview({
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
