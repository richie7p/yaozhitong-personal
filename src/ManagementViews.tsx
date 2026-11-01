import { useEffect, useRef, useState } from "react";
import {
  Users,
  Copy,
  Plus,
  Bell,
  Download,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "./api";
import { useAuth } from "./auth";
import { JobHistory } from "./JobHistory";
import { cabinetExpiryStatus } from "../shared/dates";
import { useTaipeiDay } from "./use-taipei-day";
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
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(invite.code);
                    setMessage("");
                  } catch {
                    setMessage(
                      "無法複製邀請碼，請直接選取畫面上的邀請碼複製。",
                    );
                  }
                }}
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
                      try {
                        setMessage("");
                        await api("/care/" + r.id, "DELETE");
                        await refresh();
                      } catch (e: any) {
                        setMessage(e.message);
                      }
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
  const today = useTaipeiDay();
  const submitting = useRef(false);
  const creationKey = useRef("");
  const [saving, setSaving] = useState(false);
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
            disabled={saving}
            onClick={() => {
              creationKey.current = crypto.randomUUID();
              setMessage("");
              setEdit({
                name: "",
                quantity: 0,
                unit: "",
                expiresAt: "",
                disposed: false,
              });
            }}
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
              if (submitting.current) return;
              submitting.current = true;
              setSaving(true);
              setMessage("");
              try {
                await api(
                  "/cabinet" + (edit.id ? "/" + edit.id : ""),
                  edit.id ? "PUT" : "POST",
                  { ...edit, expiresAt: edit.expiresAt || null },
                  edit.id ? undefined : creationKey.current,
                );
                creationKey.current = "";
                setEdit(null);
                refresh();
              } catch (e: any) {
                setMessage(e.message);
                if (e.code === "cabinet_saved_conflict") refresh();
              } finally {
                submitting.current = false;
                setSaving(false);
              }
            }}
          >
            <Field label="名稱">
              <input
                required
                disabled={saving}
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="剩餘數量">
              <input
                required
                disabled={saving}
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
                disabled={saving}
                value={edit.unit}
                onChange={(e) => setEdit({ ...edit, unit: e.target.value })}
              />
            </Field>
            <Field label="有效日期">
              <input
                disabled={saving}
                type="date"
                value={edit.expiresAt || ""}
                onChange={(e) =>
                  setEdit({ ...edit, expiresAt: e.target.value })
                }
              />
            </Field>
            <div className="full-grid">
              <Button type="submit" className="primary" disabled={saving}>
                {saving ? "儲存中…" : "儲存"}
              </Button>{" "}
              <Button disabled={saving} onClick={() => setEdit(null)}>取消</Button>
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
          data.items.map((r: any) => {
            const expiry = cabinetExpiryStatus(r, today);
            return (
              <div className="list-row" key={r.id}>
                <div className="grow">
                  <strong>{r.name}</strong>
                  <small>
                    {r.quantity} {r.unit} ·{" "}
                    {r.expiresAt ? "有效至 " + r.expiresAt : "尚未填寫效期"}
                  </small>
                </div>
                <span
                  className={"tag " + (expiry === "expired" ? "amber" : "")}
                >
                  {expiry === "disposed"
                    ? "已處理"
                    : expiry === "expired"
                      ? "已過期"
                      : "保存中"}
                </span>
                <Button disabled={saving} onClick={() => setEdit(r)}>編輯</Button>
                {!r.disposed && (
                  <Button
                    onClick={async () => {
                      try {
                        setMessage("");
                        await api("/cabinet/" + r.id, "PUT", {
                          ...r,
                          disposed: true,
                        });
                        await refresh();
                      } catch (e: any) {
                        setMessage(e.message);
                      }
                    }}
                  >
                    標記已處理
                  </Button>
                )}
              </div>
            );
          })
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
    [notificationBusy, setNotificationBusy] = useState(false),
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
              {auth.config.publicAccess === "verified"
                ? auth.emailVerified
                  ? "已驗證，可使用全部一般功能"
                  : "請驗證信箱以啟用 AI"
                : auth.me.account.eligible
                  ? "已取得測試資格"
                  : "尚待管理員開通 AI 測試資格"}
            </span>
            <div className="stack">
              <Button
                className="secondary"
                disabled={notificationBusy}
                onClick={async () => {
                  setMessage("");
                  setNotificationBusy(true);
                  try {
                    await action(auth.notify, "已啟用這台裝置的推播。");
                  } finally {
                    setNotificationBusy(false);
                  }
                }}
              >
                <Bell size={17} />
                {notificationBusy ? "正在啟用推播…" : "啟用網頁推播"}
              </Button>
              {notificationBusy && (
                <p role="status" className="fine">
                  請查看瀏覽器的通知權限提示並選擇允許，正在連線推播服務。
                </p>
              )}
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
              iPhone／iPad 請先將網站加入主畫面，再從主畫面啟用通知。
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
export { Admin } from "./AdminConsole";
