import { useState } from "react";
import { api } from "./api";
import { Button, Busy, Empty, Evidence, Notice, useData } from "./components";
export function JobHistory() {
  const { data, error, loading, refresh } = useData("/jobs");
  const [message, setMessage] = useState("");
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
                  onClick={async () => {
                    try {
                      await api("/jobs/" + job.id + "/retry", "POST", {});
                      setMessage("已重新排入處理，稍後請重新整理。");
                      refresh();
                    } catch (e: any) {
                      setMessage(e.message);
                    }
                  }}
                >
                  使用原輸入重試
                </Button>
              )}
            {job.status === "failed" && job.kind === "recognition" && (
              <a className="btn" href="#add">
                重新上傳藥袋
              </a>
            )}
            {job.status === "succeeded" && job.result?.claims && (
              <details>
                <summary>查看當時結果（個人資料或仿單可能已更新）</summary>
                <Evidence result={job.result} />
              </details>
            )}
            {job.status === "succeeded" && job.kind === "recognition" && (
              <details>
                <summary>查看辨識原文</summary>
                {job.result.medications.map((m: any, i: number) => (
                  <p key={i}>{m.rawText}</p>
                ))}
              </details>
            )}
          </div>
        ))
      )}
    </section>
  );
}
