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
import { Notifications } from "./NotificationViews";
import { Demo } from "./Demo";
import { Home, BagDrawing } from "./Home";
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
  }, [pageName, auth.me?.account.id]);
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
  if (pageName === "privacy") return <PrivacyPage />;
  if (auth.loading) return <Busy />;
  if (!auth.me) return <Login />;
  const account = auth.me.account;
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
      <Admin />
    ) : (
      <Notice error>此功能需要管理員權限。</Notice>
    ),
  };
  return (
    <div
      className="app"
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
        <a className="brand" href="#home">
          <img src="/icon.svg" alt="" />
          <div>
            藥智通<small>看懂用藥・記錄日常</small>
          </div>
        </a>
        <span className="nav-label">日常紀錄與閱讀</span>
        <nav aria-label="主要導覽">
          {navigation.map(([id, label, Icon], index) => (
            <a
              href={"#" + id}
              key={id}
              className={pageName === id ? "active" : ""}
              aria-current={pageName === id ? "page" : undefined}
            >
              <span className="nav-number" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <Icon size={18} />
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            href="#demo"
            className={pageName === "demo" ? "active demo-link" : "demo-link"}
            aria-current={pageName === "demo" ? "page" : undefined}
          >
            <Presentation size={19} />
            研討會展示
          </a>
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
          <a href="#profile">
            <Settings size={18} />
            帳號與設定
          </a>
          {account.admin && (
            <a href="#admin">
              <ShieldCheck size={18} />
              管理員後台
            </a>
          )}
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
              <span>個人用藥手帳</span>
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
                      admin: "管理員後台",
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
          <span>以官方仿單為依據，陪你看懂每一份用藥資訊。</span>
          <PrivacyLink />
        </footer>
      </div>
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
    </div>
  );
}
function Login() {
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
    <div className="login-page">
      <section className="login-story">
        <a className="brand" href="/">
          <img src="/icon.svg" alt="" />
          <div>
            藥智通<small>用藥有據，日常有序。</small>
          </div>
        </a>
        <div>
          <span className="eyebrow">你的個人用藥手帳</span>
          <h1>
            把用藥，
            <br />
            看清楚。
          </h1>
          <p>
            從藥袋、仿單，到每一天的服藥紀錄。
            <br />
            一份資訊，一步一步讀懂。
          </p>
          <div className="story-steps">
            <span>
              <b>01</b>辨識藥袋
            </span>
            <ArrowRight />
            <span>
              <b>02</b>閱讀說明
            </span>
            <ArrowRight />
            <span>
              <b>03</b>理解與記錄
            </span>
          </div>
        </div>
        <div className="login-illustration">
          <BagDrawing />
        </div>
        <div className="story-bottom">
          <ShieldCheck size={18} />
          官方仿單依據・使用者逐項確認
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="eyebrow">藥智通 / 個人用藥</span>
          <h2>
            {mode === "register"
              ? "開始你的健康日常"
              : mode === "reset"
                ? "重設密碼"
                : "歡迎回來"}
          </h2>
          <p className="muted">
            {mode === "register"
              ? "先建立帳號並驗證信箱，再確認 AI 試用資格。"
              : mode === "reset"
                ? "輸入註冊時使用的信箱，我們會寄送重設密碼連結。"
                : "開啟你的藥品、說明與服藥紀錄。"}
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
                    目前為受控試用。完成註冊與信箱驗證後，仍需另行取得 AI
                    試用資格，才能使用 AI 功能。
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
                    setMode(mode === "login" ? "register" : "login");
                    setPassword("");
                    setShowPassword(false);
                    setMessage("");
                  }}
                >
                  {mode === "login" ? "建立新帳號" : "返回登入"}
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
          <PrivacyLink />
        </div>
      </section>
    </div>
  );
}
