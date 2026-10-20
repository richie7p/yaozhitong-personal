import { useEffect, useId, useState } from "react";
import { BookOpen, Check } from "lucide-react";
import type {
  Citation,
  GroundedResult,
  LearningProgress,
  Medication,
} from "../shared/schema";
import {
  learningProgress,
  profileReferenceLabel,
  validAnswers,
} from "../shared/learning";
import { api, ApiError } from "./api";
import { Button, Notice, Speak } from "./components";

export const learningStateLabels: Record<LearningProgress["status"], string> = {
  not_started: "未開始",
  in_progress: "進行中",
  completed: "已完成",
  unavailable: "尚無測驗",
};

function SourceQuotes({
  citations,
  result,
}: {
  citations: Citation[];
  result: GroundedResult;
}) {
  return (
    <>
      {citations.map((x, i) => {
        const chunk = result.chunks.find((c) => c.id === x.chunkId);
        return (
          <blockquote key={i}>
            {x.quote}
            <footer>
              {chunk?.licenseNo} · 第 {chunk?.page} 頁 · 版本{" "}
              {chunk?.version.slice(0, 8)}
            </footer>
          </blockquote>
        );
      })}
    </>
  );
}

function CitationDetails({
  citations,
  result,
}: {
  citations: Citation[];
  result: GroundedResult;
}) {
  return (
    <details>
      <summary>
        <BookOpen size={15} /> 對照仿單原文
      </summary>
      <SourceQuotes citations={citations} result={result} />
    </details>
  );
}

function HealthReferences({
  claim,
}: {
  claim: GroundedResult["claims"][number];
}) {
  if (claim.profileRefs?.length)
    return (
      <p className="profile-reference">
        <strong>參考你填寫的資料：</strong>
        {claim.profileRefs.map(profileReferenceLabel).join("；")}
      </p>
    );
  if (!claim.sourceMentions?.length) return null;
  return (
    <p className="profile-reference source-mention">
      仿單原文提到你填寫的
      {claim.sourceMentions.map((ref) => "「" + ref.value + "」").join("、")}
      ；請對照原文中的適用條件。
    </p>
  );
}

function EducationSummary({
  result,
  medications,
}: {
  result: GroundedResult;
  medications: Medication[];
}) {
  const purposes = result.claims.filter(
    (c) => c.category === "purpose" || (!c.category && c.kind === "purpose"),
  );
  const personal = result.claims.filter(
    (c) => c.profileRefs?.length || c.sourceMentions?.length,
  );
  return (
    <div className="education-summary">
      <section className="education-card">
        <h3>藥品用途</h3>
        {purposes.length ? (
          purposes.slice(0, 3).map((c, i) => (
            <div key={i}>
              <p>{c.text}</p>
              <CitationDetails citations={c.citations} result={result} />
            </div>
          ))
        ) : (
          <p className="muted">
            目前沒有可引用的用途摘要，可閱讀下方完整說明。
          </p>
        )}
        <small>仿單用途不代表醫師為你開藥的原因。</small>
      </section>
      <section className="education-card confirmed-usage">
        <h3>你已確認的用法</h3>
        {!medications.some((m) => m.confirmed) && (
          <p className="muted">回到「我的藥品」查看已確認的用法。</p>
        )}
        {medications
          .filter((m) => m.confirmed)
          .map((m) => (
            <div key={m.id}>
              <strong>{m.name}</strong>
              <p>
                每次 {doseLabel(m)} · {m.frequencyRaw}
              </p>
              {m.route && <p>途徑：{m.route}</p>}
              {m.prn && <p>需要時使用</p>}
              {m.instructions && <p>{m.instructions}</p>}
            </div>
          ))}
        <small>依你核對後儲存的藥袋用法顯示。</small>
      </section>
      <section className="education-card personal-precautions">
        <h3>對照你填寫資料的提醒</h3>
        {personal.length ? (
          personal.slice(0, 3).map((c, i) => (
            <div key={i}>
              <HealthReferences claim={c} />
              <p>{c.text}</p>
              <CitationDetails citations={c.citations} result={result} />
            </div>
          ))
        ) : (
          <p className="muted">
            目前沒有可確認與你健康資料相關的提醒，請閱讀下方的一般注意事項。
          </p>
        )}
        <small>完整提醒與警語保留在下方。</small>
      </section>
    </div>
  );
}

function UnderstandingQuiz({
  result,
  learningId,
  initialAnswers = {},
  onProgress,
}: {
  result: GroundedResult;
  learningId: string;
  initialAnswers?: Record<string, number>;
  onProgress?: (progress: LearningProgress) => void;
}) {
  const radioName = useId();
  const [answers, setAnswers] = useState(() =>
    validAnswers(result.quiz, initialAnswers),
  );
  const [index, setIndex] = useState(() => {
    const p = learningProgress(result.quiz, initialAnswers);
    const first = p.results.findIndex((r) => !r.correct);
    return first < 0 ? 0 : first;
  });
  const [selection, setSelection] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const initialKey = JSON.stringify(initialAnswers);
  useEffect(() => {
    setAnswers(validAnswers(result.quiz, JSON.parse(initialKey)));
  }, [learningId, initialKey]);
  const progress = learningProgress(result.quiz, answers);
  const q = result.quiz[index];
  if (!q) return null;
  const selected = selection ?? answers[q.id];
  const grade = progress.results[index];
  const move = (next: number) => {
    setIndex(next);
    setSelection(undefined);
    setMessage("");
  };
  return (
    <section className="card quiz" aria-label="理解確認">
      <div className="row spread">
        <h3>花一分鐘，確認自己看懂了</h3>
        <span className={"tag " + (progress.passed ? "green" : "amber")}>
          {learningStateLabels[progress.status]}
        </span>
      </div>
      <p className="muted">答題進度不影響你的用藥提醒。</p>
      <p className="quiz-progress" aria-live="polite">
        已作答 {progress.answered}／{progress.total} 題 · 已答對{" "}
        {progress.correct} 題
      </p>
      {stale ? (
        <Notice error>
          {message} <a href="#medications">回到我的藥品，重新產生說明</a>
        </Notice>
      ) : progress.passed && !reviewing ? (
        <>
          <Notice>答對了。已完成測驗，進度已保存。</Notice>
          <Button
            className="secondary"
            onClick={() => {
              setReviewing(true);
              move(0);
            }}
          >
            重新複習
          </Button>
        </>
      ) : (
        <>
          <fieldset disabled={saving}>
            <legend>
              第 {index + 1}／{progress.total} 題：{q.q}
            </legend>
            {q.options.map((option, i) => (
              <label className="choice" key={i}>
                <input
                  type="radio"
                  name={radioName + q.id}
                  value={i}
                  checked={selected === i}
                  onChange={() => setSelection(i)}
                />
                {option}
              </label>
            ))}
          </fieldset>
          {grade.state !== "unanswered" && (
            <div className="quiz-feedback">
              <Notice error={!grade.correct}>
                {grade.correct ? "答對了。" : "再看一下："}
                {q.explain}
              </Notice>
              <h4>回看這題的仿單依據</h4>
              <SourceQuotes citations={q.citations} result={result} />
              {!grade.correct && <p>讀完說明後，選擇答案再檢查一次。</p>}
            </div>
          )}
          <div className="row wrap quiz-actions">
            <Button
              disabled={
                saving ||
                selected === undefined ||
                (grade.correct && selected === answers[q.id])
              }
              onClick={async () => {
                if (selected === undefined) return;
                setSaving(true);
                setMessage("");
                try {
                  const response = await api<{
                    answers: Record<string, number>;
                    progress: LearningProgress;
                  }>("/learning/" + learningId + "/answers", "POST", {
                    answers: { [q.id]: selected },
                  });
                  setAnswers(response.answers);
                  setSelection(undefined);
                  onProgress?.(response.progress);
                } catch (e) {
                  setMessage(
                    e instanceof Error
                      ? e.message
                      : "暫時無法保存答案，請重試。",
                  );
                  if (
                    e instanceof ApiError &&
                    (e.code === "stale_content" || e.code === "not_found")
                  )
                    setStale(true);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <Check size={16} /> {saving ? "正在保存…" : "檢查答案"}
            </Button>
            {index > 0 && (
              <Button
                className="ghost"
                disabled={saving}
                onClick={() => move(index - 1)}
              >
                上一題
              </Button>
            )}
            {index < result.quiz.length - 1 && (
              <Button
                className="secondary"
                disabled={saving || !grade.correct}
                onClick={() => move(index + 1)}
              >
                下一題
              </Button>
            )}
            {reviewing && progress.passed && (
              <Button className="ghost" onClick={() => setReviewing(false)}>
                完成複習
              </Button>
            )}
          </div>
          {message && <Notice error>{message}</Notice>}
        </>
      )}
    </section>
  );
}

export function Evidence({
  result,
  learningId,
  medications,
  initialAnswers,
  onProgress,
  showQuiz = true,
}: {
  result: GroundedResult;
  learningId?: string;
  medications?: Medication[];
  initialAnswers?: Record<string, number>;
  onProgress?: (progress: LearningProgress) => void;
  showQuiz?: boolean;
}) {
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
      {medications && (
        <EducationSummary result={result} medications={medications} />
      )}
      {medications && result.claims.length > 0 && (
        <h3>已核對的說明與注意事項</h3>
      )}
      {result.claims.map((c, i) => (
        <article className="claim" key={i}>
          <div className="claim-number">{String(i + 1).padStart(2, "0")}</div>
          <div>
            {c.category === "use" && <span className="tag">仿單一般用法</span>}
            <HealthReferences claim={c} />
            <p>{c.text}</p>
            <CitationDetails citations={c.citations} result={result} />
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
      {showQuiz && learningId && result.quiz.length > 0 && (
        <UnderstandingQuiz
          key={learningId}
          result={result}
          learningId={learningId}
          initialAnswers={initialAnswers}
          onProgress={onProgress}
        />
      )}
      {showQuiz &&
        learningId &&
        result.status === "supported" &&
        result.quiz.length === 0 && (
          <Notice>
            目前可閱讀說明，暫無可用的理解題。用藥提醒與服藥紀錄仍可使用。
          </Notice>
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
import { doseLabel } from "../shared/medication";
