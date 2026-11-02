import { useEffect, useRef, useState } from "react";
import {
  Pill,
  House,
  CalendarCheck,
  ScanLine,
  Users,
  MessageCircle,
  Settings,
  ShieldCheck,
  ArrowRight,
  Bell,
  LogOut,
  Menu,
  X,
  Package,
  Sparkles,
  BookOpen,
  Presentation,
  History as HistoryIcon,
} from "lucide-react";
import { useAuth } from "./auth";
import { authErrorMessage } from "./auth-errors";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { Button, Busy, Field, Notice, SectionTitle } from "./components";
import { Medications, AddMedication, Learning, Chat } from "./MedicationViews";
import { Care, Cabinet, Profile, Admin, History } from "./ManagementViews";
import { JobHistory } from "./JobHistory";
import { adminSections } from "./AdminConsole";
import { Notifications } from "./NotificationViews";
import { Demo } from "./Demo";
import { Home } from "./Home";
import { CareIllustration } from "./CareIllustration";
import { SupportPage } from "./Support";
import { PrivacyPage, PrivacyLink } from "./Privacy";
const navigation = [
  ["home", "今日總覽", House],
  ["medications", "我的藥品", Pill],
  ["learning", "用藥小教室", Sparkles],
  ["history", "服藥紀錄", CalendarCheck],
  ["cabinet", "家庭藥箱", Package],
  ["care", "家人照護", Users],
  ["chat", "用藥問答", MessageCircle],
] as const;
export function App() {
  const auth = useAuth();
  const [page, setPage] = useState(location.hash.slice(1) || "home"),
    [menu, setMenu] = useState(false),
    [scale, setScale] = useState(1),
    [online, setOnline] = useState(navigator.onLine);
  const [pageName, pageQuery = ""] = page.split("?");
  useEffect(() => {
    if (!auth.me) return;
    // A user can reach a control before the first frame after sign-in or navigation.
    // Once they interact, keep their focus instead of moving it to the page title.
    const cancelFocus = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", cancelFocus);
      document.removeEventListener("pointerdown", cancelFocus);
      document.removeEventListener("keydown", cancelFocus);
    };
    const frame = requestAnimationFrame(() => {
      cancelFocus();
      const heading = document.querySelector<HTMLElement>("#main h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      window.scrollTo(0, 0);
    });
    document.addEventListener("focusin", cancelFocus);
    document.addEventListener("pointerdown", cancelFocus);
    document.addEventListener("keydown", cancelFocus);
    return cancelFocus;
  }, [pageName, pageName === "admin" ? pageQuery : "", auth.me?.account.id]);
  const menuTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    menuTrigger.current = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLElement>(".sidebar a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
      if (event.key !== "Tab") return;
      const links = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".sidebar a[href], .sidebar button",
        ),
      );
      const first = links[0],
        last = links.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (menuTrigger.current?.isConnected) menuTrigger.current.focus();
    };
  }, [menu]);
  useEffect(() => {
    const hash = () => {
      setPage(location.hash.slice(1) || "home");
      setMenu(false);
    };
    const net = () => setOnline(navigator.onLine);
    window.addEventListener("hashchange", hash);
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
    };
  }, []);
  if (pageName === "support") return <SupportPage />;
  if (pageName === "privacy") return <PrivacyPage />;
  if (auth.loading) return <Busy />;
  if (!auth.me) return <Login adminEntry={pageName === "admin"} />;
  const account = auth.me.account;
  const adminWorkspace = pageName === "admin" && account.admin;
  const adminView = new URLSearchParams(pageQuery).get("view") || "overview";
  const pages: Record<string, React.ReactNode> = {
    home: <Home />,
    medications: <Medications />,
    add: (
      <>
        {new URLSearchParams(pageQuery).get("from") === "demo" && (
          <div className="demo-context">
            <Presentation size={18} />
            <span>研討會展示 · 藥袋辨識</span>
            <a
              className="text-link"
              href={
                "#demo?record=" +
                encodeURIComponent(
                  new URLSearchParams(pageQuery).get("record") || "",
                )
              }
            >
              返回展示導覽
            </a>
          </div>
        )}
        <AddMedication
          recognitionId={new URLSearchParams(pageQuery).get("recognition")}
        />
      </>
    ),
    learning: <Learning />,
    demo: <Demo />,
    jobs: (
      <>
        <SectionTitle eyebrow="接著完成手上的事" title="處理紀錄與恢復">
          查看辨識與說明的處理狀態，從中斷的地方繼續。
        </SectionTitle>
        <JobHistory />
      </>
    ),
    chat: <Chat />,
    care: <Care />,
    cabinet: <Cabinet />,
    profile: <Profile />,
    history: <History />,
    notifications: <Notifications />,
    admin: account.admin ? (
      <Admin section={adminView} />
    ) : (
      <section className="card access-panel">
        <ShieldCheck size={38} />
        <h1>這是管理員專用工作區</h1>
        <p>你目前的身分是一般使用者，可繼續使用自己的用藥與照護功能。</p>
        <a className="btn primary" href="#home">
          回到我的用藥
        </a>
      </section>
    ),
  };
  return (
    <div
      className={"app public-app" + (adminWorkspace ? " admin-workspace" : "")}
      style={{ "--font-scale": scale } as React.CSSProperties}
    >
      <a
        className="skip"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳到主要內容
      </a>
      <aside
        className={menu ? "sidebar open" : "sidebar"}
        aria-label="功能選單"
        role={menu ? "dialog" : undefined}
        aria-modal={menu || undefined}
        onClick={(event) => {
          if ((event.target as Element).closest("a[href]")) setMenu(false);
        }}
      >
        <button
          type="button"
          className="icon-button drawer-close"
          aria-label="關閉選單"
          onClick={() => setMenu(false)}
        >
          <X size={21} />
        </button>
        <a className="brand" href={adminWorkspace ? "#admin" : "#home"}>
          <img src="/icon.svg" alt="" />
          <div>
            藥智通
            <small>
              {adminWorkspace ? "管理員工作區" : "你的日常用藥夥伴"}
            </small>
          </div>
        </a>
        <div
          className={"workspace-identity " + (adminWorkspace ? "is-admin" : "")}
        >
          <ShieldCheck size={16} />
          <span>{account.admin ? "管理員" : "一般使用者"}</span>
          <small>{adminWorkspace ? "服務管理" : "個人空間"}</small>
        </div>
        {!adminWorkspace && (
          <a href="#add" className="btn primary sidebar-add">
            <ScanLine size={19} />
            新增藥袋
          </a>
        )}
        <span className="nav-label">
          {adminWorkspace ? "服務管理" : "我的健康日常"}
        </span>
        <nav aria-label={adminWorkspace ? "管理員導覽" : "主要導覽"}>
          {adminWorkspace
            ? adminSections.map(([id, label], index) => {
                const Icon = [
                  House,
                  BookOpen,
                  Users,
                  HistoryIcon,
                  MessageCircle,
                ][index];
                return (
                  <a
                    key={id}
                    href={"#admin?view=" + id}
                    className={adminView === id ? "active" : ""}
                    aria-current={adminView === id ? "page" : undefined}
                  >
                    <Icon size={19} />
                    {label}
                  </a>
                );
              })
            : navigation.map(([id, label, Icon]) => (
                <a
                  href={"#" + id}
                  key={id}
                  className={pageName === id ? "active" : ""}
                  aria-current={pageName === id ? "page" : undefined}
                >
                  <Icon size={19} />
                  {label}
                </a>
              ))}
        </nav>
        <div className="sidebar-bottom">
          {!adminWorkspace && (
            <>
              <a
                href="#notifications"
                aria-current={pageName === "notifications" ? "page" : undefined}
              >
                <Bell size={18} />
                通知紀錄
              </a>
              <a
                href="#jobs"
                aria-current={pageName === "jobs" ? "page" : undefined}
              >
                <HistoryIcon size={18} />
                處理紀錄與恢復
              </a>
              <a href="#support">
                <MessageCircle size={18} />
                問題回報
              </a>
              <a href="#profile">
                <Settings size={18} />
                帳號與設定
              </a>
            </>
          )}
          {account.admin && (
            <a
              className="workspace-switch"
              href={adminWorkspace ? "#home" : "#admin"}
            >
              <ShieldCheck size={18} />
              {adminWorkspace ? "回到我的用藥" : "管理員後台"}
              <ArrowRight size={15} />
            </a>
          )}
          {account.admin && (
            <a href="#demo" className="demo-link">
              <Presentation size={18} />
              研討會展示
            </a>
          )}
          <div className="sidebar-help">
            <BookOpen size={19} />
            <span>
              每一步，都有依據。<small>官方仿單・由你核對</small>
            </span>
          </div>
        </div>
      </aside>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className="workspace">
        <header className="topbar">
          <div className="row">
            <button
              className="icon-button mobile-menu"
              aria-label="開啟選單"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X /> : <Menu />}
            </button>
            <span className="top-label">
              <span>{adminWorkspace ? "管理員工作區" : "我的用藥"}</span>
              <i>/</i>
              <strong>
                {navigation.find(([id]) => id === pageName)?.[1] ||
                  (
                    {
                      add: "新增用藥",
                      demo: "研討會展示",
                      jobs: "處理紀錄",
                      notifications: "通知紀錄",
                      profile: "帳號與設定",
                      admin:
                        adminSections.find(([id]) => id === adminView)?.[1] ||
                        "管理總覽",
                    } as Record<string, string>
                  )[pageName] ||
                  "藥智通"}
              </strong>
            </span>
          </div>
          <div className="row">
            <button
              className="font-button"
              onClick={() => setScale(scale >= 1.2 ? 1 : scale + 0.1)}
              aria-label="調整字級"
            >
              Aa
            </button>
            <a
              className="icon-button"
              href="#notifications"
              aria-label="通知紀錄"
              aria-current={pageName === "notifications" ? "page" : undefined}
            >
              <Bell size={19} />
            </a>
            <span className={"role-pill" + (account.admin ? " admin" : "")}>
              {account.admin ? "管理員" : "一般使用者"}
            </span>
            <div className="avatar">{account.displayName?.[0] || "我"}</div>
            <span className="user-name">{account.displayName}</span>
            <button
              className="icon-button"
              aria-label="登出"
              onClick={() => auth.logout()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1} key={account.id + page}>
          {auth.authError && <Notice error>{auth.authError}</Notice>}
          {auth.config.mode !== "local" && !auth.emailVerified && (
            <Notice>
              請開啟信箱中的驗證信。完成後可到<a href="#profile">帳號與設定</a>
              更新驗證狀態或重寄驗證信。
            </Notice>
          )}
          {!online && <Notice error>目前離線，請連線後讀取或更新資料。</Notice>}
          {auth.config.mode === "local" && (
            <div className="local-banner">
              <span className="dot" />
              本機使用 · 資料保存在這台電腦 ·{" "}
              {auth.config.ai
                ? `${auth.config.aiProviderLabel || "AI"} API 已設定`
                : "AI 尚未設定"}
            </div>
          )}
          {pages[pageName] || pages.home}
        </main>
        <footer className="site-footer">
          <span>藥智通・用藥手帳</span>
          <span>從官方仿單與可靠醫療資料，陪你看懂用藥資訊。</span>
          <PrivacyLink />{" "}
          <a className="text-link" href="#support">
            問題回報
          </a>
        </footer>
      </div>
      {!adminWorkspace && (
        <nav className="bottom-nav" aria-label="手機主要導覽">
          <a
            href="#home"
            className={pageName === "home" ? "active" : ""}
            aria-current={pageName === "home" ? "page" : undefined}
          >
            <House size={21} />
            <span>今日</span>
          </a>
          <a
            href="#medications"
            className={pageName === "medications" ? "active" : ""}
            aria-current={pageName === "medications" ? "page" : undefined}
          >
            <Pill size={21} />
            <span>藥品</span>
          </a>
          <a
            href="#add"
            className={"capture-nav" + (pageName === "add" ? " active" : "")}
            aria-current={pageName === "add" ? "page" : undefined}
          >
            <span className="capture-nav-icon">
              <ScanLine size={22} />
            </span>
            <span>拍藥袋</span>
          </a>
          <a
            href="#learning"
            className={pageName === "learning" ? "active" : ""}
            aria-current={pageName === "learning" ? "page" : undefined}
          >
            <BookOpen size={21} />
            <span>小教室</span>
          </a>
          <button
            type="button"
            aria-label="更多功能"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={21} />
            <span>更多</span>
          </button>
        </nav>
      )}
    </div>
  );
}
function Login({ adminEntry = false }: { adminEntry?: boolean }) {
  const {
    config,
    login,
    googleCredential,
    authError,
    reload,
    sessionRecovery,
  } = useAuth();
  const [mode, setMode] = useState("login"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [showPassword, setShowPassword] = useState(false),
    [busy, setBusy] = useState(false),
    [messageError, setMessageError] = useState(false),
    [message, setMessage] = useState("");
  async function go(method: string) {
    setBusy(true);
    setMessage("");
    setMessageError(false);
    try {
      await login(method, email, password);
      if (method === "reset")
        setMessage("若此信箱可重設密碼，你將收到操作信件。");
    } catch (e: any) {
      setMessageError(true);
      setMessage(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={"login-page public-login auth-" + mode + (adminEntry ? " admin-login" : "")}
    >
      <section className="login-story">
        <a className="brand" href="/">
          <img src="/icon.svg" alt="" />
          <div>
            藥智通<small>用藥有據，日常有序。</small>
          </div>
        </a>
        <div>
          <span className="eyebrow login-kicker">
            <span className="status-dot" />
            每天多一點清楚，少一點擔心
          </span>
          <h1>
            把每天的用藥，
            <br />
            <em>照顧得更清楚。</em>
          </h1>
          <p>
            拍下藥袋、核對資料，讀懂自己的用藥。
            <br />
            提醒與紀錄，都在同一個地方。
          </p>
          <div className="story-steps">
            <span>
              <b>1</b>拍下藥袋
            </span>
            <ArrowRight />
            <span>
              <b>2</b>核對資料
            </span>
            <ArrowRight />
            <span>
              <b>3</b>讀懂用藥
            </span>
          </div>
        </div>
        <div className="login-illustration">
          <div className="illustration-label">
            <ScanLine size={19} />
            <span>從一張藥袋，開始整理</span>
          </div>
          <CareIllustration />
          <div className="illustration-note">
            <ShieldCheck size={20} />
            <span>逐項確認，再放心保存</span>
          </div>
        </div>
        <div className="story-bottom">
          <ShieldCheck size={18} />
          官方仿單依據・使用者逐項確認
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="login-card-brand">
            <img src="/icon.svg" alt="" />
            <span>藥智通</span>
          </div>
          <span className="login-role">
            <ShieldCheck size={16} />
            {adminEntry ? "管理員專用入口" : "一般使用者入口"}
          </span>
          <h2>
            {mode === "register"
              ? "開始你的健康日常"
              : mode === "reset"
                ? "重設密碼"
                : adminEntry
                  ? "管理員登入"
                  : "歡迎來到藥智通"}
          </h2>
          <p className="muted">
            {mode === "register"
              ? config?.publicAccess === "verified"
                ? "建立帳號並驗證信箱，即可開始使用。"
                : "先建立帳號並驗證信箱，再確認 AI 試用資格。"
              : mode === "reset"
                ? "輸入註冊時使用的信箱，我們會寄送重設密碼連結。"
                : adminEntry
                  ? "請使用已授權的管理員帳號。"
                  : "登入後，從第一張藥袋開始。"}
          </p>
          {authError && (
            <>
              <Notice error>{authError}</Notice>
              <Button
                className="secondary full"
                disabled={busy}
                onClick={async () => {
                  if (!sessionRecovery) {
                    location.reload();
                    return;
                  }
                  setBusy(true);
                  setMessage("");
                  try {
                    await reload();
                  } catch (error) {
                    setMessageError(true);
                    setMessage(authErrorMessage(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {sessionRecovery ? "重試連線並恢復登入" : "重新載入登入頁"}
              </Button>
            </>
          )}
          {config?.error && <Notice error>{config.error}</Notice>}
          {!adminEntry && (
            <a className="admin-login-link" href="#admin">
              管理員登入 <ArrowRight size={14} />
            </a>
          )}
          {config?.error ? (
            <Button className="primary full" onClick={() => location.reload()}>
              重新連線
            </Button>
          ) : config?.mode === "local" ? (
            <>
              <Notice>
                本機開發帳號，資料互相隔離；新帳號沒有預載健康資料。
              </Notice>
              {config.localAccounts.map((p: any) => (
                <Button
                  className={p.uid === "local-owner" ? "primary" : "secondary"}
                  key={p.uid}
                  disabled={busy}
                  onClick={() => go(p.uid)}
                >
                  {p.name}
                  <ArrowRight size={17} />
                </Button>
              ))}
            </>
          ) : (
            <>
              {config?.googleOAuthClientId ? (
                <GoogleSignInButton
                  clientId={config.googleOAuthClientId}
                  disabled={busy}
                  onCredential={async (idToken) => {
                    setBusy(true);
                    setMessage("");
                    try {
                      await googleCredential(idToken);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              ) : (
                <Button
                  className="google"
                  disabled={busy}
                  onClick={() => go("google")}
                >
                  <strong>G</strong>使用 Google 登入
                </Button>
              )}
              <div className="divider">或使用電子信箱</div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  go(mode);
                }}
              >
                <Field label="電子信箱">
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    disabled={busy}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </Field>
                {mode !== "reset" && (
                  <div className="field password-field">
                    <label htmlFor="login-password">密碼</label>
                    <div className="password-input">
                      <input
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        autoComplete={
                          mode === "register"
                            ? "new-password"
                            : "current-password"
                        }
                        minLength={mode === "register" ? 8 : undefined}
                        aria-describedby={
                          mode === "register"
                            ? "register-password-help"
                            : undefined
                        }
                        required
                        disabled={busy}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={
                          mode === "register" ? "至少 8 個字元" : "輸入密碼"
                        }
                      />
                      <button
                        type="button"
                        className="text-button password-toggle"
                        aria-controls="login-password"
                        aria-pressed={showPassword}
                        disabled={busy}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? "隱藏密碼" : "顯示密碼"}
                      </button>
                    </div>
                    {mode === "register" && (
                      <small id="register-password-help" className="muted">
                        至少 8 個字元。
                      </small>
                    )}
                  </div>
                )}
                {mode === "register" && (
                  <p
                    id="registration-trial-notice"
                    className="registration-trial-notice"
                  >
                    {config?.publicAccess === "verified"
                      ? `完成註冊與信箱驗證後，即可使用全部一般功能。AI 每人每日 ${config.dailyUserLimit} 次，全站每日 ${config.dailyGlobalLimit} 次，額滿後隔日恢復。`
                      : "目前為受控試用。完成註冊與信箱驗證後，仍需另行取得 AI 試用資格，才能使用 AI 功能。"}
                  </p>
                )}
                <Button className="primary full" type="submit" disabled={busy}>
                  {busy
                    ? "處理中…"
                    : mode === "register"
                      ? "建立帳號"
                      : mode === "reset"
                        ? "寄送重設信"
                        : "登入"}
                  <ArrowRight size={17} />
                </Button>
              </form>
              <div className="row spread">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    if (adminEntry) {
                      location.hash = "home";
                      setMode("login");
                    } else setMode(mode === "login" ? "register" : "login");
                    setPassword("");
                    setShowPassword(false);
                    setMessage("");
                  }}
                >
                  {adminEntry
                    ? "返回一般使用者登入"
                    : mode === "login"
                      ? "建立新帳號"
                      : "返回登入"}
                </button>
                {mode !== "reset" && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setMode("reset");
                      setPassword("");
                      setShowPassword(false);
                      setMessage("");
                    }}
                  >
                    忘記密碼？
                  </button>
                )}
              </div>
            </>
          )}
          {message && <Notice error={messageError}>{message}</Notice>}
          {config?.mode !== "local" && !config?.error && (
            <p className="fine">
              登入狀態會保留在此分頁；共用裝置使用完畢後請登出。
            </p>
          )}
          <p className="fine">
            本服務提供仿單資訊整理與用藥紀錄，不能取代醫師或藥師的專業判斷。
          </p>
          <PrivacyLink />{" "}
          <a className="text-link" href="#support">
            問題回報
          </a>
        </div>
      </section>
    </div>
  );
}
