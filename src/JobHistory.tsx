import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Busy, Empty, Notice, useData } from "./components";
import { Evidence } from "./Evidence";
export function JobHistory() {
  const { data, error, loading, refresh } = useData("/jobs");
  const [message, setMessage] = useState("");
  const [retrying, setRetrying] = useState("");
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
        <Button onClick={refresh}>重新整理</Button>
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
          <div className="card small" key={job.id}>
            <div className="row spread">
              <h3>{names[job.kind]}</h3>
              <span className="tag">{states[job.status]}</span>
            </div>
            <small>{new Date(job.createdAt).toLocaleString("zh-TW")}</small>
            {job.error && <p>{job.error.message}</p>}
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
            {job.status === "succeeded" && job.result?.claims && (
              <details>
                <summary>查看當時結果（個人資料或仿單可能已更新）</summary>
                <Evidence result={job.result} showQuiz={false} />
              </details>
            )}
            {job.status === "succeeded" &&
              (job.kind === "bundle" || job.kind === "interaction") && (
                <a className="btn secondary" href="#learning">
                  開啟用藥小教室與目前進度
                </a>
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
