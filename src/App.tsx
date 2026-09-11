import { useEffect, useState } from "react";
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
  Plus,
  Bell,
  LogOut,
  Heart,
  Menu,
  X,
  Package,
  Sun,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { useAuth } from "./auth";
import { api } from "./api";
import {
  Button,
  Busy,
  Empty,
  Field,
  Notice,
  SectionTitle,
  useData,
} from "./components";
import { Medications, AddMedication, Learning, Chat } from "./MedicationViews";
import { Care, Cabinet, Profile, Admin, History } from "./ManagementViews";
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
  if (auth.loading) return <Busy />;
  if (!auth.me) return <Login />;
  const account = auth.me.account;
  const pages: Record<string, React.ReactNode> = {
    home: <Home />,
    medications: <Medications />,
    add: <AddMedication />,
    learning: <Learning />,
    chat: <Chat />,
    care: <Care />,
    cabinet: <Cabinet />,
    profile: <Profile />,
    history: <History />,
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
      <a className="skip" href="#main">
        跳到主要內容
      </a>
      <aside className={menu ? "sidebar open" : "sidebar"}>
        <a className="brand" href="#home">
          <img src="/icon.svg" alt="" />
          <div>
            藥智通<small>YOUR DAILY CARE</small>
          </div>
        </a>
        <span className="nav-label">我的健康日常</span>
        <nav>
          {navigation.map(([id, label, Icon]) => (
            <a
              href={"#" + id}
              key={id}
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={20} />
              {label}
              {id === "chat" && <span className="tiny-tag">AI</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="care-note">
            <Heart size={22} />
            <p>
              照顧自己，
              <br />
              也讓在乎的人安心。
            </p>
            <span>每一天，都安心一點</span>
          </div>
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
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X /> : <Menu />}
            </button>
            <span className="top-label">健康，從看懂用藥開始</span>
          </div>
          <div className="row">
            <button
              className="font-button"
              onClick={() => setScale(scale >= 1.2 ? 1 : scale + 0.1)}
              aria-label="調整字級"
            >
              Aa
            </button>
            <a className="icon-button" href="#profile" aria-label="通知設定">
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
        <main id="main" key={account.id + page}>
          {!online && <Notice error>目前離線，請連線後讀取或更新資料。</Notice>}
          {auth.config.mode === "local" && (
            <div className="local-banner">
              <span className="dot" />
              本機開發模式 · 資料保存在這台電腦 ·{" "}
              {auth.config.ai ? "NVIDIA API 已設定" : "AI 尚未設定"}
            </div>
          )}
          {pages[page] || pages.home}
        </main>
        <footer className="site-footer">
          <span>藥智通 YAOZHITONG</span>
          <span>以官方仿單為依據，陪你看懂每一份用藥資訊。</span>
        </footer>
      </div>
      <nav className="bottom-nav">
        {navigation
          .filter((x) => ["home", "medications", "care", "chat"].includes(x[0]))
          .map(([id, label, Icon]) => (
            <a key={id} href={"#" + id} className={page === id ? "active" : ""}>
              <Icon size={21} />
              <span>{label}</span>
            </a>
          ))}
      </nav>
    </div>
  );
}
function Login() {
  const { config, login } = useAuth();
  const [mode, setMode] = useState("login"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function go(method: string) {
    setBusy(true);
    setMessage("");
    try {
      await login(method, email, password);
      if (method === "reset")
        setMessage("若此信箱可重設密碼，你將收到操作信件。");
    } catch (e: any) {
      const text: Record<string, string> = {
        "auth/invalid-credential": "信箱或密碼不正確。",
        "auth/email-already-in-use": "此信箱已有帳號，請登入原帳號後連結。",
        "auth/popup-closed-by-user": "登入視窗已關閉。",
        "auth/weak-password": "密碼強度不足，請至少使用 8 個字元。",
        "auth/account-exists-with-different-credential":
          "此信箱已有其他登入方式，請用原方式登入後，到設定連結 Google。",
      };
      setMessage(text[e.code] || e.message);
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
            藥智通<small>YOUR DAILY CARE</small>
          </div>
        </a>
        <div>
          <span className="eyebrow">少一點疑惑，多一點安心</span>
          <h1>
            看懂每一顆藥，
            <br />
            照顧每一天的你。
          </h1>
          <p>
            從藥袋到仿單，讓用藥資訊更清楚。
            <br />
            把日常的照顧，留給自己與在乎的人。
          </p>
          <div className="story-steps">
            <span>
              <ScanLine />
              拍下藥袋
            </span>
            <ArrowRight />
            <span>
              <Pill />
              確認用法
            </span>
            <ArrowRight />
            <span>
              <Heart />
              安心記錄
            </span>
          </div>
        </div>
        <div className="story-bottom">
          <ShieldCheck size={18} />
          資訊有出處，照護有連結。
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="eyebrow">WELCOME TO YAOZHITONG</span>
          <h2>{mode === "register" ? "開始你的健康日常" : "歡迎回來"}</h2>
          <p className="muted">登入後，繼續照顧今天的自己。</p>
          {config?.error && <Notice error>{config.error}</Notice>}
          {config?.mode === "local" ? (
            <>
              <Notice>
                本機開發帳號，資料互相隔離；新帳號沒有預載健康資料。
              </Notice>
              {config.localAccounts.map((p: any) => (
                <Button
                  className={p.admin ? "secondary" : "primary"}
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
              <Button
                className="google"
                disabled={busy}
                onClick={() => go("google")}
              >
                <strong>G</strong>使用 Google 登入
              </Button>
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
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </Field>
                {mode !== "reset" && (
                  <Field label="密碼">
                    <input
                      type="password"
                      autoComplete={
                        mode === "register"
                          ? "new-password"
                          : "current-password"
                      }
                      minLength={8}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="至少 8 個字元"
                    />
                  </Field>
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
                  onClick={() =>
                    setMode(mode === "register" ? "login" : "register")
                  }
                >
                  {mode === "register" ? "已有帳號，登入" : "建立新帳號"}
                </button>
                <button
                  className="text-button"
                  onClick={() => setMode("reset")}
                >
                  忘記密碼？
                </button>
              </div>
            </>
          )}
          {message && <Notice>{message}</Notice>}
          <p className="fine">
            本服務提供仿單資訊整理與用藥紀錄，不能取代醫師或藥師的專業判斷。
          </p>
        </div>
      </section>
    </div>
  );
}
function Home() {
  const { me } = useAuth();
  const today = useData("/today"),
    meds = useData("/medications");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timer = setInterval(() => {
      today.refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  const rows = today.data?.items || [];
  const done = rows.filter((r: any) => r.log?.status === "taken").length;
  const date = new Intl.DateTimeFormat("zh-TW", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Taipei",
  }).format(new Date());
  async function log(row: any, status: string) {
    try {
      await api("/dose-logs", "POST", {
        medicationId: row.medicationId,
        dueAt: row.dueAt,
        status,
      });
      await today.refresh();
    } catch (e: any) {
      setMessage(e.message);
    }
  }
  return (
    <>
      <SectionTitle
        eyebrow={date}
        title={`${me.account.displayName}，今天也照顧好自己。`}
        action={
          <a className="btn primary" href="#add">
            <Plus size={18} />
            新增藥品
          </a>
        }
      >
        每一個小小的記錄，都是照顧自己的開始。
      </SectionTitle>
      <div className="home-grid">
        <div className="home-main">
          <section className="hero-card">
            <div>
              <span className="hero-label">
                <Sun size={16} /> YOUR DAILY MOMENT
              </span>
              <h2>
                把用藥的事，
                <br />
                一件一件，放在心上。
              </h2>
              <p>
                看懂、確認、記錄。
                <br />
                讓今天的健康日常更有把握。
              </p>
              <a href="#medications">
                查看我的藥品 <ArrowRight size={18} />
              </a>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="pill-art">
                <span />
              </div>
              <div className="float-check">
                <CheckCircle2 size={24} />
              </div>
              <div className="leaf-art" />
            </div>
          </section>
          <div className="stats">
            <div>
              <span>目前藥品</span>
              <strong>
                {meds.data?.items?.length || 0}
                <small>款</small>
              </strong>
              <span className="stat-caption">集中管理，隨時查閱</span>
            </div>
            <div>
              <span>今日已記錄服用</span>
              <strong>
                {done}
                <small>/ {rows.length} 次</small>
              </strong>
              <span className="stat-caption">依你確認的排程</span>
            </div>
            <div>
              <span>待確認用法</span>
              <strong>
                {meds.data?.items?.filter((m: any) => !m.confirmed).length || 0}
                <small>款</small>
              </strong>
              <span className="stat-caption">確認後再設定提醒</span>
            </div>
          </div>
          <section className="card">
            <div className="row spread">
              <h2>
                <CalendarCheck size={20} />
                今天的用藥
              </h2>
              <a className="text-link" href="#history">
                全部紀錄 <ArrowRight size={15} />
              </a>
            </div>
            {today.loading ? (
              <Busy />
            ) : rows.length === 0 ? (
              <Empty
                title="今天還沒有用藥排程"
                action={
                  <a className="btn secondary" href="#medications">
                    設定我的用藥 <ArrowRight size={16} />
                  </a>
                }
              >
                先新增藥品、確認用法，再選擇適合你的提醒時間。
              </Empty>
            ) : (
              <div className="timeline">
                {rows.map((r: any) => (
                  <div key={r.id} className="dose-row">
                    <span className="dose-time">{r.time}</span>
                    <div className="dose-dot" />
                    <div className="dose-info">
                      <h3>{r.name}</h3>
                      <p>
                        {r.doseAmount} {r.doseUnit}
                      </p>
                    </div>
                    <div className="dose-action">
                      {r.log ? (
                        <span
                          className={
                            "tag " + (r.log.status === "taken" ? "green" : "")
                          }
                        >
                          {r.log.status === "taken" ? "已記錄服用" : "已略過"}
                        </span>
                      ) : (
                        <>
                          <Button
                            className="secondary"
                            onClick={() => log(r, "taken")}
                          >
                            <CheckCircle2 size={16} />
                            已服用
                          </Button>
                          <button
                            className="text-button"
                            onClick={() => log(r, "skipped")}
                          >
                            略過
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(today.error || message) && (
              <Notice error>{today.error || message}</Notice>
            )}
          </section>
        </div>
        <aside className="home-side">
          <section className="card start-card">
            <span className="eyebrow">A LITTLE HELP</span>
            <h2>從一張藥袋開始</h2>
            <p>拍下藥袋，協助整理藥名與用法，再由你逐項確認。</p>
            <div className="scan-visual">
              <ScanLine size={56} strokeWidth={1} />
              <span>讓複雜的資訊，變清楚</span>
            </div>
            <a className="btn primary full" href="#add">
              <ScanLine size={17} />
              辨識我的藥袋
            </a>
          </section>
          <section className="card family-card">
            <div className="circle-icon">
              <Users size={24} />
            </div>
            <h3>關心，可以更靠近</h3>
            <p>邀請家人查看你的用藥紀錄，分享每一天的安心。</p>
            <a className="text-link" href="#care">
              設定家人照護 <ArrowRight size={16} />
            </a>
          </section>
          <div className="trust-note">
            <ShieldCheck size={22} />
            <div>
              <strong>每一份說明，都有出處</strong>
              <p>AI 整理內容可對照官方仿單原文。</p>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
