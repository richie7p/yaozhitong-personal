import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  const mounted = useRef(false),
    requestVersion = useRef(0),
    currentPath = useRef(path);
  currentPath.current = path;
  const refresh = useCallback(async () => {
    if (!mounted.current || currentPath.current !== path) return;
    const version = ++requestVersion.current;
    const isCurrent = () =>
      mounted.current &&
      currentPath.current === path &&
      requestVersion.current === version;
    setError("");
    try {
      const next = await api<T>(path);
      if (isCurrent()) setData(next);
    } catch (e: any) {
      if (isCurrent()) setError(e.message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    setData(null);
    void refresh();
    return () => {
      mounted.current = false;
      requestVersion.current++;
    };
  }, [refresh]);
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
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => () => {
    try {
      const speech = typeof window === "undefined" ? undefined : window.speechSynthesis;
      if (typeof speech?.cancel === "function") speech.cancel();
    } catch {
      // Optional audio cleanup must not interrupt reading or navigation.
    }
  }, []);
  let supported = false;
  try {
    supported = typeof window !== "undefined" &&
      typeof window.speechSynthesis?.cancel === "function" &&
      typeof window.speechSynthesis?.speak === "function" &&
      typeof window.SpeechSynthesisUtterance === "function";
  } catch {
    // Some environments expose an API without allowing access to it.
  }
  if (!supported || unavailable)
    return <span className="fine">目前無法朗讀，可繼續閱讀文字。</span>;
  return (
    <button
      className="btn ghost"
      onClick={() => {
        try {
          const speech = window.speechSynthesis;
          const Utterance = window.SpeechSynthesisUtterance;
          if (typeof speech?.cancel !== "function" || typeof speech?.speak !== "function" ||
              typeof Utterance !== "function") {
            setPlaying(false);
            setUnavailable(true);
            return;
          }
          if (playing) {
            speech.cancel();
            setPlaying(false);
            return;
          }
          const u = new Utterance(text);
          u.lang = "zh-TW";
          u.rate = 0.85;
          u.onend = () => setPlaying(false);
          speech.cancel();
          speech.speak(u);
          setPlaying(true);
        } catch {
          setPlaying(false);
          setUnavailable(true);
        }
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
      <a href="#jobs" className="btn ghost">
        查看 AI 處理紀錄與重試
      </a>
      <p className="muted">離開頁面後仍會繼續處理，可回到紀錄查看結果。</p>
    </div>
  );
}
