import { useEffect, useRef, useState } from "react";
import { api, submitJob } from "./api";
import { publicApiErrorMessage } from "./api-error-messages";
import { Button, Busy, Empty, Notice, useData } from "./components";
import { Evidence } from "./Evidence";
import { DrugExplanation } from "./DrugExplanation";
import { DrugQuerySchema } from "../shared/drug-explanation";

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
  async function requery() {
    if (checking.current) return;
    const original = checked?.result?.queriedProduct;
    const query = DrugQuerySchema.safeParse(original && {
      name: original.name,
      strength: original.strength || "",
      form: original.form || "",
      ...(original.licenseNo ? { licenseNo: original.licenseNo } : {}),
    });
    if (!query.success) {
      setError("這筆紀錄沒有完整查詢文字，請前往一般藥品查詢重新輸入藥名。");
      return;
    }
    const version = ++requestVersion.current;
    checking.current = true;
    setLoading(true);
    setError("");
    try {
      const current = await submitJob("/explanations", { query: query.data });
      if (live.current && requestVersion.current === version) setChecked(current);
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
  const emptyExplanation = job.kind === "explanation" &&
    checked?.result?.mode === "general_information" &&
    checked.result.status !== "refused" &&
    !checked.result.assistance?.claims?.some(
      (claim: { basis: string; text: string }) =>
        claim.basis === "reference" && claim.text.trim(),
    );
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
      <summary>
        {job.kind === "explanation"
          ? "查看一般藥品解說"
          : "查看可用結果（先核對目前產品資料）"}
      </summary>
      {loading && <Busy text="正在核對這筆結果…" />}
      {error && (
        <Notice error>
          {error} <Button onClick={load}>重新核對結果</Button>
        </Notice>
      )}
      {checked?.explanationUpdateRequired ? (
        <Notice>
          這份一般解說的查詢資料或來源已更新，請重新查詢。
          <a href="#add?mode=quick">前往一般藥品查詢</a>
        </Notice>
      ) : checked?.sourceUpdateRequired ? (
        <Notice>
          仿單整理規則已更新，請重新產生說明與測驗。
          <a href="#medications">回到我的藥品</a>
        </Notice>
      ) : checked?.identityReviewRequired ? (
        <Notice>
          產品身分或資料已更新，暫不提供先前仿單回答。
          <a href="#medications">補齊產品資料</a>
        </Notice>
      ) : (
        checked?.result && (
          <>
            {job.kind === "explanation" ? (
              <DrugExplanation result={checked.result} />
            ) : (
              <Evidence result={checked.result} showQuiz={false} />
            )}
            {emptyExplanation && (
              <Notice>
                本次未取得基本用藥資訊。可使用這筆紀錄的藥名重新搜尋，會使用 1 次 AI 額度。
                <Button disabled={loading} onClick={requery}>
                  重新查詢基本用藥資訊
                </Button>
              </Notice>
            )}
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
    recognition: "藥品辨識",
    chat: "用藥問答",
    bundle: "AI 藥品解說",
    explanation: "一般藥品解說",
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
                {job.explanationUpdateRequired
                  ? "需要重新查詢"
                  : job.sourceUpdateRequired
                    ? job.kind === "explanation"
                      ? "一般解說需更新"
                      : "說明規則已更新"
                    : job.identityReviewRequired
                      ? "產品待核對"
                      : job.sourceReviewPending
                        ? "AI 內容待整理"
                        : job.sourceReadingPending
                          ? "部分內容尚未整理"
                          : states[job.status]}
              </span>
            </div>
            <small>{new Date(job.createdAt).toLocaleString("zh-TW")}</small>
            {job.error && (
              <p>{publicApiErrorMessage(job.error.code, job.error.message)}</p>
            )}
            {job.sourceUpdateRequired && (
              <Notice>
                {job.kind === "explanation" ? (
                  <>
                    這份一般藥品解說已到期或查詢規則更新，請重新查詢。
                    <a href="#add?mode=quick">前往一般藥品查詢</a>
                  </>
                ) : (
                  <>
                    仿單整理規則已更新，請重新產生說明與測驗。
                    <a href="#medications">回到我的藥品</a>
                  </>
                )}
              </Notice>
            )}
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
              ["chat", "bundle", "interaction", "explanation"].includes(
                job.kind,
              ) && (
                <>
                  <p className="muted">
                    這次任務已達重試上限。請先依上方訊息處理，確定可繼續後再回原功能。
                  </p>
                  <a
                    className="btn secondary"
                    href={
                      job.kind === "explanation"
                        ? "#add?mode=quick"
                        : job.kind === "chat"
                          ? "#chat"
                          : job.kind === "bundle"
                            ? "#medications"
                            : "#learning"
                    }
                  >
                    {job.kind === "explanation"
                      ? "回到一般藥品查詢"
                      : job.kind === "chat"
                        ? "回到用藥問答"
                        : job.kind === "bundle"
                          ? "回到我的藥品"
                          : "回到用藥小教室"}
                  </a>
                </>
              )}
            {job.status === "failed" && job.kind === "recognition" && (
              <a className="btn" href="#add">
                重新上傳藥品照片
              </a>
            )}
            {job.status === "succeeded" &&
              ["chat", "bundle", "interaction", "explanation"].includes(
                job.kind,
              ) && (
                <JobResultPreview
                  key={job.id + ":" + job.updatedAt + ":" + previewVersion}
                  job={job}
                />
              )}
            {job.status === "succeeded" && job.kind === "recognition" && (
              <>
                <a
                  className="btn secondary"
                  href={
                    "#add?mode=chronic&recognition=" +
                    encodeURIComponent(job.id)
                  }
                >
                  繼續核對辨識結果
                </a>
                <a
                  className="btn secondary"
                  href={
                    "#add?mode=quick&recognition=" + encodeURIComponent(job.id)
                  }
                >
                  查詢一般藥品解說
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
