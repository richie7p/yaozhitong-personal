import { useEffect, useState, type ReactNode } from "react";
import {
  LoaderCircle,
  AlertCircle,
  BookOpen,
  Volume2,
  Check,
  ArrowUpRight,
} from "lucide-react";
import type { GroundedResult } from "../shared/schema";
import { api } from "./api";
export function useData<T = any>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const refresh = async () => {
    setError("");
    try {
      setData(await api<T>(path));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    api<T>(path)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return { data, error, loading, refresh };
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={"notice " + (error ? "error" : "")}
      role={error ? "alert" : "status"}
    >
      <AlertCircle size={18} />
      <span>{children}</span>
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <BookOpen size={30} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Busy({ text = "正在載入…" }: { text?: string }) {
  return (
    <div className="busy" role="status">
      <LoaderCircle className="spin" size={20} />
      {text}
    </div>
  );
}
export function Button({
  children,
  onClick,
  className = "",
  disabled = false,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={"btn " + className}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function SectionTitle({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}
export function Speak({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => speechSynthesis.cancel(), []);
  return (
    <button
      className="btn ghost"
      onClick={() => {
        if (playing) {
          speechSynthesis.cancel();
          setPlaying(false);
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "zh-TW";
        u.rate = 0.85;
        u.onend = () => setPlaying(false);
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
        setPlaying(true);
      }}
    >
      <Volume2 size={16} />
      {playing ? "停止朗讀" : "朗讀說明"}
    </button>
  );
}
export function Evidence({
  result,
  learningId,
}: {
  result: GroundedResult;
  learningId?: string;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({}),
    [grades, setGrades] = useState<any[] | null>(null),
    [message, setMessage] = useState("");
  const labels = {
    supported: "已附仿單依據",
    not_found: "依現有仿單資料未發現記載",
    insufficient_data: "目前仿單資料不足",
    refused: "這個問題需要醫師或藥師判斷",
  };
  return (
    <div className="evidence">
      <div className="row spread">
        <span
          className={
            "tag " + (result.status === "supported" ? "green" : "amber")
          }
        >
          {labels[result.status]}
        </span>
        {result.claims.length > 0 && (
          <Speak text={result.claims.map((c) => c.text).join("。")} />
        )}
      </div>
      {result.status !== "supported" && (
        <Notice>
          {result.status === "refused"
            ? "目前提供仿單資訊整理。調整劑量、停藥、診斷與個人用藥判斷，請交由醫師或藥師協助。"
            : "你仍可保存藥品與已確認用法。沒有記載不代表沒有風險。"}
        </Notice>
      )}
      {result.claims.map((c, i) => (
        <article className="claim" key={i}>
          <div className="claim-number">{String(i + 1).padStart(2, "0")}</div>
          <div>
            <p>{c.text}</p>
            <details>
              <summary>
                <BookOpen size={15} />
                對照仿單原文
              </summary>
              {c.citations.map((x, j) => {
                const ch = result.chunks.find((c) => c.id === x.chunkId);
                return (
                  <blockquote key={j}>
                    {x.quote}
                    <footer>
                      {ch?.licenseNo} · 第 {ch?.page} 頁 · 版本{" "}
                      {ch?.version.slice(0, 8)}
                    </footer>
                  </blockquote>
                );
              })}
            </details>
          </div>
        </article>
      ))}
      {result.followups?.map((f, i) => (
        <details className="card small" key={i}>
          <summary>{f.question}</summary>
          <p>{result.claims[f.claimIndex]?.text}</p>
          <small>若這項情況與你有關，請向藥師確認。</small>
        </details>
      ))}
      {result.quiz?.length > 0 && (
        <div className="card quiz">
          <h3>花一分鐘，確認自己看懂了</h3>
          <p className="muted">答題進度不影響你的用藥提醒。</p>
          {result.quiz.map((q, i) => (
            <fieldset key={q.id}>
              <legend>
                {i + 1}. {q.q}
              </legend>
              {q.options.map((o, index) => (
                <label className="choice" key={index}>
                  <input
                    type="radio"
                    name={(learningId || "quiz") + q.id}
                    checked={answers[q.id] === index}
                    onChange={() => {
                      setAnswers({ ...answers, [q.id]: index });
                      setGrades(null);
                    }}
                  />
                  {o}
                </label>
              ))}
              {grades && (
                <Notice error={!grades[i]?.correct}>
                  {grades[i]?.correct ? "答對了。" : "再看一下："}
                  {q.explain}
                </Notice>
              )}
            </fieldset>
          ))}
          <Button
            onClick={async () => {
              try {
                if (learningId)
                  setGrades(
                    (
                      await api(
                        "/learning/" + learningId + "/answers",
                        "POST",
                        { answers },
                      )
                    ).results,
                  );
                else
                  setGrades(
                    result.quiz.map((q) => ({
                      correct: answers[q.id] === q.answer,
                    })),
                  );
              } catch (e: any) {
                setMessage(e.message);
              }
            }}
          >
            <Check size={16} />
            檢查答案
          </Button>
          {message && <Notice error>{message}</Notice>}
        </div>
      )}
      {result.rejectedCount > 0 && (
        <small className="muted">
          {result.rejectedCount} 條內容未通過驗證，已隱藏。
        </small>
      )}
      <p className="fine">
        AI 整理與模型輔助驗證仍可能有誤，請以原文核對；內容供用藥資訊理解參考。
      </p>
    </div>
  );
}
