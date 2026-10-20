import { useEffect, useState, type ReactNode } from "react";
import {
  LoaderCircle,
  AlertCircle,
  BookOpen,
  Volume2,
  ArrowUpRight,
} from "lucide-react";
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
export function JobNotice({ text }: { text: string }) {
  return (
    <div className="job-notice">
      <Busy text={text} />
      <a href="#profile" className="btn ghost">
        查看 AI 處理紀錄與重試
      </a>
      <p className="muted">離開頁面後仍會繼續處理，可回到紀錄查看結果。</p>
    </div>
  );
}
