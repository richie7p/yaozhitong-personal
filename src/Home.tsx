import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ScanLine,
  BookOpen,
  ArrowUpRight,
  ShieldCheck,
  Pill,
  CalendarCheck,
} from "lucide-react";
import { useAuth } from "./auth";
import { api } from "./api";
import { Button, Busy, Empty, Notice, useData } from "./components";
import { doseLabel } from "../shared/medication";

export function BagDrawing() {
  return (
    <svg
      className="bag-drawing"
      viewBox="0 0 280 220"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M53 31H213L228 193H39L53 31Z"
        fill="#F6F2E6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M53 43H214M49 66H216" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M69 85H151M69 95H178M69 108H125"
        stroke="#9AA497"
        strokeWidth="2"
      />
      <rect x="69" y="126" width="132" height="42" stroke="#C7CBBE" />
      <path
        d="M78 139H115M78 151H138M153 139H190M153 151H177"
        stroke="#9AA497"
        strokeWidth="2"
      />
      <path
        d="M26 85V70H42M226 70H242V85M26 162V178H42M226 178H242V162"
        stroke="#B65438"
        strokeWidth="2.5"
      />
      <path
        d="M24 119H245"
        stroke="#B65438"
        strokeWidth="1.5"
        strokeDasharray="4 4"
      />
      <path d="M207 181L215 189L233 168" stroke="#183F37" strokeWidth="2.5" />
      <circle cx="232" cy="38" r="6" fill="#B65438" />
    </svg>
  );
}

export function Home() {
  const { me } = useAuth();
  const today = useData("/today"),
    meds = useData("/medications"),
    learning = useData("/learning");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState("");
  useEffect(() => {
    const refreshToday = () => {
      void today.refresh();
    };
    const timer = setInterval(refreshToday, 30000);
    window.addEventListener("yzt-schedules-changed", refreshToday);
    return () => {
      clearInterval(timer);
      window.removeEventListener("yzt-schedules-changed", refreshToday);
    };
  }, []);
  const rows = today.data?.items || [];
  const done = rows.filter((r: any) => r.log?.status === "taken").length;
  const date = new Intl.DateTimeFormat("zh-TW", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Taipei",
  }).format(new Date());
  const parts = new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Taipei",
  }).formatToParts(new Date());
  const day = parts.find((p) => p.type === "day")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  async function log(row: any, status: string) {
    if (saving) return;
    setSaving(row.id);
    setMessage("");
    try {
      await api("/dose-logs", "POST", {
        medicationId: row.medicationId,
        dueAt: row.dueAt,
        status,
      });
      await today.refresh();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setSaving("");
    }
  }
  const total = today.loading || today.error ? "—" : rows.length;
  const pending =
    meds.loading || meds.error
      ? "—"
      : meds.data?.items?.filter(
          (m: any) => !m.confirmed || m.identityReview?.status !== "confirmed",
        ).length || 0;
  return (
    <div className="journal-home">
      <header className="journal-heading">
        <div>
          <p className="eyebrow">
            你好，{me.account.displayName || "朋友"}{" "}
            <span className="greeting-dot" />
          </p>
          <h1>今天的用藥日常</h1>
          <p className="journal-intro">依你確認的用法，記錄每一次服藥。</p>
        </div>
        <div className="journal-date" aria-label={date}>
          <strong>{day}</strong>
          <span>
            {month}月<br />
            {weekday}
          </span>
        </div>
      </header>
      <section className="next-step-card" aria-label="接下來可以做什麼">
        <div className="next-step-copy">
          <span className="next-step-label">
            <ShieldCheck size={16} />
            一步一步，把用藥整理好
          </span>
          <h2>
            {meds.loading
              ? "正在讀取你的用藥…"
              : meds.error
                ? "先重新讀取你的用藥"
                : Number(pending) > 0
                  ? "還差一步，完成藥品核對"
                  : !meds.data?.items?.length
                    ? "從第一張藥袋開始"
                    : "你的用藥，隨時清楚掌握"}
          </h2>
          <p>
            {meds.error
              ? "目前無法確認清單，重新讀取後再繼續。"
              : Number(pending) > 0
                ? `有 ${pending} 款藥品需要你確認產品或用法。對照原藥袋，確認後再閱讀說明。`
                : !meds.data?.items?.length
                  ? "拍下清楚的藥袋，系統先整理，你再逐項確認。也可以搜尋藥名或手動新增。"
                  : "查看今天的提醒、讀懂官方說明，讓每次記錄都有依據。"}
          </p>
          {meds.error ? (
            <Button className="primary" onClick={meds.refresh}>
              重新讀取藥品
            </Button>
          ) : (
            !meds.loading && (
              <a
                className="btn primary"
                href={
                  Number(pending) > 0
                    ? "#medications"
                    : !meds.data?.items?.length
                      ? "#add"
                      : "#learning"
                }
              >
                {Number(pending) > 0
                  ? "繼續核對藥品"
                  : !meds.data?.items?.length
                    ? "新增我的第一款藥"
                    : "閱讀我的用藥說明"}
                <ArrowRight size={18} />
              </a>
            )
          )}
        </div>
        <ol className="welcome-steps" aria-label="用藥整理流程">
          <li>
            <span>
              <ScanLine size={21} />
            </span>
            <div>
              <strong>1. 拍下藥袋</strong>
              <small>藥名與用法清楚入鏡</small>
            </div>
          </li>
          <li>
            <span>
              <ShieldCheck size={21} />
            </span>
            <div>
              <strong>2. 由你核對</strong>
              <small>確認產品、用量與頻次</small>
            </div>
          </li>
          <li>
            <span>
              <BookOpen size={21} />
            </span>
            <div>
              <strong>3. 讀懂與記錄</strong>
              <small>閱讀說明，建立日常提醒</small>
            </div>
          </li>
        </ol>
      </section>
      <nav className="quick-actions" aria-label="常用功能">
        <a href="#add">
          <span className="quick-icon mint">
            <ScanLine size={23} />
          </span>
          <div>
            <strong>拍藥袋・新增用藥</strong>
            <small>拍攝、搜尋或手動輸入</small>
          </div>
          <ArrowUpRight size={18} />
        </a>
        <a href="#medications">
          <span className="quick-icon blue">
            <Pill size={23} />
          </span>
          <div>
            <strong>我的藥品</strong>
            <small>核對資料與閱讀仿單</small>
          </div>
          <ArrowUpRight size={18} />
        </a>
        <a href="#history">
          <span className="quick-icon peach">
            <CalendarCheck size={23} />
          </span>
          <div>
            <strong>回顧服藥紀錄</strong>
            <small>每一筆日常，清楚保存</small>
          </div>
          <ArrowUpRight size={18} />
        </a>
      </nav>
      <div className="journal-layout">
        <div className="journal-main">
          <dl className="journal-numbers">
            <div>
              <dt>今日排程</dt>
              <dd>
                {total}
                <small>次</small>
              </dd>
            </div>
            <div>
              <dt>已記錄服用</dt>
              <dd>
                {today.loading || today.error ? "—" : done}
                <small>次</small>
              </dd>
            </div>
            <div>
              <dt>待核對藥品</dt>
              <dd>
                <a href="#medications">
                  {pending}
                  <small>款</small>
                </a>
              </dd>
            </div>
          </dl>
          <section className="day-agenda" aria-labelledby="today-agenda-title">
            <div className="agenda-heading">
              <h2 id="today-agenda-title">今天的用藥</h2>
              <a className="text-link" href="#history">
                全部紀錄 <ArrowUpRight size={16} />
              </a>
            </div>
            {today.loading ? (
              <Busy />
            ) : today.error ? (
              <>
                <Notice error>{today.error}</Notice>
                <Button className="secondary" onClick={today.refresh}>
                  重新讀取今天的用藥
                </Button>
              </>
            ) : !rows.length ? (
              <Empty
                title="今天還沒有用藥排程"
                action={
                  <a className="btn secondary" href="#medications">
                    設定我的用藥 <ArrowRight size={16} />
                  </a>
                }
              >
                先新增藥品、確認用法，再選擇提醒時間。
              </Empty>
            ) : (
              <div className="agenda-list">
                {rows.map((r: any, i: number) => (
                  <div
                    className={"agenda-row" + (r.log ? " is-recorded" : "")}
                    key={r.id}
                  >
                    <div className="agenda-time">
                      <span className="agenda-position">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <time>{r.time}</time>
                    </div>
                    <div className="agenda-drug">
                      <h3>{r.name}</h3>
                      <p>{doseLabel(r)}</p>
                    </div>
                    <div className="agenda-action">
                      {r.log ? (
                        <span
                          className={
                            "recorded-label " +
                            (r.log.status === "taken" ? "taken" : "")
                          }
                        >
                          {r.log.status === "taken" && <Check size={15} />}{" "}
                          {r.log.status === "taken" ? "已記錄服用" : "已略過"}
                        </span>
                      ) : (
                        <>
                          <Button
                            className="secondary"
                            disabled={!!saving}
                            onClick={() => log(r, "taken")}
                          >
                            <Check size={16} />
                            {saving === r.id ? "記錄中…" : "已服用"}
                          </Button>
                          <button
                            disabled={!!saving}
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
            {message && <Notice error>{message}</Notice>}
          </section>
          <div className="journal-footnote">
            <span className="footnote-mark">記</span>
            <p>以上時間依你設定的排程顯示。請對照藥袋確認用法，再記錄服藥。</p>
          </div>
        </div>
        <aside className="journal-side">
          <section className="capture-panel">
            <div className="panel-caption">
              <span>新增一款用藥</span>
              <span>01</span>
            </div>
            <BagDrawing />
            <h2>
              從藥袋，
              <br />
              開始看清楚。
            </h2>
            <p>
              拍下藥名與用法，
              <br />
              再逐項核對辨識結果。
            </p>
            <a className="btn primary full" href="#add">
              <ScanLine size={18} />
              拍攝我的藥袋 <ArrowRight size={17} />
            </a>
            <a className="capture-manual" href="#add">
              也可以搜尋藥名或手動新增 <ArrowUpRight size={14} />
            </a>
          </section>
          <a className="reading-entry" href="#learning">
            <BookOpen size={23} />
            <div>
              <span className="eyebrow">用藥小教室</span>
              <h3>讀懂說明，再做練習</h3>
              <p>
                {learning.loading
                  ? "正在讀取學習內容…"
                  : learning.error
                    ? "重新開啟學習內容"
                    : `已保存 ${learning.data?.items?.length || 0} 份說明`}
              </p>
            </div>
            <ArrowUpRight size={19} />
          </a>
          {meds.error && <Notice error>無法讀取藥品清單：{meds.error}</Notice>}
          <p className="journal-owner">
            {me.account.displayName}的個人用藥紀錄
          </p>
        </aside>
      </div>
    </div>
  );
}
