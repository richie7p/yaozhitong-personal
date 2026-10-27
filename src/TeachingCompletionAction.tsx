import { useEffect, useRef, useState } from "react";
import type { LearningRecord } from "../shared/schema";
import { needsTeachingCompletion } from "../shared/teaching-completion";
import { api, submitJob } from "./api";
import { Button, Notice } from "./components";

export function TeachingCompletionAction({ record, onCompleted }: {
  record: LearningRecord;
  onCompleted: (record: LearningRecord) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  if (!needsTeachingCompletion(record.result)) return record.result.plainLanguageCoverage?.status === "partial"
    ? <p className="muted">剩餘欄位需要進一步整理來源或分段處理，請先對照仿單原文；目前不會重複扣額度要求補齊。</p> : null;
  return <div className="teaching-completion-action">
    <p className="muted">這份說明仍有待補齊的內容。可保留目前閱讀與作答紀錄，再產生一份補充說明；會使用 1 次 AI 額度。</p>
    <Button className="secondary" disabled={!!busy} onClick={async () => {
      if (active.current) return;
      active.current = true;
      const current = ++generation.current;
      setBusy("正在補齊說明與測驗…");
      setError("");
      try {
        const job = await submitJob("/bundles", {
          medicationIds: record.medicationIds,
          previousLearningId: record.id,
        }, (message) => {
          if (generation.current === current) setBusy(message);
        });
        const fresh = await api<{ items: LearningRecord[] }>("/learning");
        const completed = fresh.items.find((item) => item.id === job.id);
        if (!completed) throw new Error("補充內容已保存，請重新載入學習目錄查看。");
        if (generation.current === current) await onCompleted(completed);
      } catch (caught) {
        if (generation.current === current)
          setError(caught instanceof Error ? caught.message : "暫時無法補齊，原有內容已保留。");
      } finally {
        active.current = false;
        if (generation.current === current) setBusy("");
      }
    }}>補齊說明與測驗</Button>
    {busy && <p role="status">{busy}</p>}
    {error && <Notice error>{error}</Notice>}
  </div>;
}
