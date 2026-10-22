import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button, Busy, Empty, Notice, useData } from "./components";
import { Evidence } from "./Evidence";

/** Recheck one requested result; polling summaries never loads private answers. */
function JobResultPreview({ job }: { job: any }) {
  const [checked, setChecked] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const live = useRef(true);
  const checking = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      requestVersion.current++;
    };
  }, []);
  async function load() {
    if (checking.current) return;
    const version = ++requestVersion.current;
    checking.current = true;
    setLoading(true);
    setChecked(null);
    setError("");
    const assertCurrent = () => {
      if (!live.current || requestVersion.current !== version)
        throw new Error("已離開這次結果核對。");
    };
    try {
      const current = await api(
        "/jobs/" + encodeURIComponent(job.id),
        "GET",
        undefined,
        undefined,
        assertCurrent,
      );
      assertCurrent();
      setChecked(current);
    } catch (cause: any) {
      if (live.current && requestVersion.current === version)
        setError(cause.message);
    } finally {
      if (live.current && requestVersion.current === version) {
        checking.current = false;
        setLoading(false);
      }
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.currentTarget.open) void load();
        else {
          requestVersion.current++;
          checking.current = false;
          setChecked(null);
          setError("");
          setLoading(false);
        }
      }}
    >
      <summary>查看可用結果（先核對目前產品資料）</summary>
      {loading && <Busy text="正在核對這筆結果…" />}
      {error && (
        <Notice error>
          {error} <Button onClick={load}>重新核對結果</Button>
        </Notice>
      )}
      {checked?.identityReviewRequired ? (
        <Notice>
          產品身分或資料已更新，暫不提供先前仿單回答。
          <a href="#medications">補齊產品資料</a>
        </Notice>
      ) : (
        checked?.result && (
          <>
            <Evidence result={checked.result} showQuiz={false} />
            {(job.kind === "bundle" || job.kind === "interaction") && (
              <a className="btn secondary" href="#learning">
                開啟用藥小教室與目前進度
              </a>
            )}
          </>
        )
      )}
    </details>
  );
}
export function JobHistory() {
  const { data, error, loading, refresh } = useData("/jobs");
  const [message, setMessage] = useState("");
  const [retrying, setRetrying] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const pending = data?.items.some(
    (j: any) => j.status === "queued" || j.status === "running",
  );
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const names: Record<string, string> = {
    recognition: "藥袋辨識",
    chat: "用藥問答",
    bundle: "仿單說明與測驗",
    interaction: "交互作用查詢",
  };
  const states: Record<string, string> = {
    queued: "等待處理",
    running: "處理中",
    succeeded: "已完成",
    failed: "未完成",
  };
  return (
    <section className="card">
      <div className="row spread">
        <h2>AI 處理紀錄</h2>
        <Button
          onClick={() => {
            setPreviewVersion((version) => version + 1);
            void refresh();
          }}
        >
          重新整理
        </Button>
      </div>
      {(error || message) && <Notice error>{error || message}</Notice>}
      {loading ? (
        <Busy />
      ) : !data?.items.length ? (
        <Empty title="還沒有 AI 處理紀錄">
          完成的結果與可重試的請求會保留在這裡。
        </Empty>
      ) : (
        data.items.map((job: any) => (
          <div className="card small" key={job.id} data-job-id={job.id}>
            <div className="row spread">
              <h3>{names[job.kind]}</h3>
              <span className="tag">
                {job.identityReviewRequired
                  ? "產品待核對"
                  : job.sourceReviewPending
                    ? "AI 內容待整理"
                    : job.sourceReadingPending
                      ? "部分內容尚未整理"
                      : states[job.status]}
              </span>
            </div>
            <small>{new Date(job.createdAt).toLocaleString("zh-TW")}</small>
            {job.error && <p>{job.error.message}</p>}
            {job.identityReviewRequired && (
              <Notice>
                這筆內容的產品資料需要重新核對，暫不提供先前仿單回答。
                <a href="#medications">補齊產品資料</a>
              </Notice>
            )}
            {job.status === "failed" &&
              job.kind !== "recognition" &&
              job.attempts < 3 && (
                <Button
                  disabled={retrying === job.id}
                  onClick={async () => {
                    setRetrying(job.id);
                    try {
                      await api("/jobs/" + job.id + "/retry", "POST", {});
                      setMessage("已使用原輸入重新排入處理，進度會自動更新。");
                      refresh();
                    } catch (e: any) {
                      setMessage(e.message);
                    } finally {
                      setRetrying("");
                    }
                  }}
                >
                  使用原輸入重試
                </Button>
              )}
            {job.status === "failed" &&
              job.attempts >= 3 &&
              ["chat", "bundle", "interaction"].includes(job.kind) && (
                <>
                  <p className="muted">
                    這次任務已達重試上限，可返回原功能重新提出請求。
                  </p>
                  <a
                    className="btn secondary"
                    href={
                      job.kind === "chat"
                        ? "#chat"
                        : job.kind === "bundle"
                          ? "#medications"
                          : "#learning"
                    }
                  >
                    {job.kind === "chat"
                      ? "回到用藥問答"
                      : job.kind === "bundle"
                        ? "回到我的藥品"
                        : "回到用藥小教室"}
                  </a>
                </>
              )}
            {job.status === "failed" && job.kind === "recognition" && (
              <a className="btn" href="#add">
                重新上傳藥袋
              </a>
            )}
            {job.status === "succeeded" &&
              ["chat", "bundle", "interaction"].includes(job.kind) && (
                <JobResultPreview
                  key={job.id + ":" + job.updatedAt + ":" + previewVersion}
                  job={job}
                />
              )}
            {job.status === "succeeded" && job.kind === "recognition" && (
              <>
                <a
                  className="btn secondary"
                  href={"#add?recognition=" + encodeURIComponent(job.id)}
                >
                  繼續核對辨識結果
                </a>
                <details>
                  <summary>查看辨識原文</summary>
                  {job.result.medications.map((m: any, i: number) => (
                    <p key={i}>{m.rawText}</p>
                  ))}
                </details>
              </>
            )}
          </div>
        ))
      )}
    </section>
  );
}
