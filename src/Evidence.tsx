import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowRight, BookOpen, Check } from "lucide-react";
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
              {chunk?.licenseNo} ·{" "}
              {chunk?.sourceFormat === "html"
                ? `官方網頁 · 區塊 ${chunk.page}`
                : `第 ${chunk?.page} 頁`}{" "}
              · 版本 {chunk?.version.slice(0, 8)}
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

function EducationSummary({ medications }: { medications: Medication[] }) {
  return (
    <section className="education-card confirmed-usage reading-prescription">
      <h4 className="reading-note-label">你已確認的用法</h4>
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
  );
}

function focusReadingTarget(target: HTMLElement | null) {
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
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
  const [saveStatus, setSaveStatus] = useState("");
  const [stale, setStale] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const questionRef = useRef<HTMLLegendElement>(null);
  const completionRef = useRef<HTMLDivElement>(null);
  const focusNextQuestion = useRef(false);
  const focusSavedCompletion = useRef(false);
  const initialKey = JSON.stringify(initialAnswers);
  useEffect(() => {
    setAnswers(validAnswers(result.quiz, JSON.parse(initialKey)));
  }, [learningId, initialKey]);
  useEffect(() => {
    if (!focusNextQuestion.current) return;
    focusNextQuestion.current = false;
    focusReadingTarget(questionRef.current);
  }, [index, reviewing]);
  const progress = learningProgress(result.quiz, answers);
  useEffect(() => {
    if (!focusSavedCompletion.current || !progress.passed || reviewing) return;
    focusSavedCompletion.current = false;
    focusReadingTarget(completionRef.current);
  }, [progress.passed, reviewing]);
  const q = result.quiz[index];
  if (!q) return null;
  const selected = selection ?? answers[q.id];
  const grade = progress.results[index];
  const move = (next: number) => {
    focusNextQuestion.current = true;
    setIndex(next);
    setSelection(undefined);
    setMessage("");
  };
  return (
    <section
      id={"quiz-" + learningId}
      className="quiz question-section"
      aria-label="理解確認"
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target === event.currentTarget && questionRef.current)
          questionRef.current.focus({ preventScroll: true });
      }}
    >
      <header className="question-heading">
        <h3>理解測驗</h3>
        <span className={"tag " + (progress.passed ? "green" : "amber")}>
          {learningStateLabels[progress.status]}
        </span>
      </header>
      <p className="muted">
        一次一題，檢查答案後保存進度，並顯示解說。不影響用藥提醒。
      </p>
      <p className="quiz-progress" aria-live="polite">
        已作答 {progress.answered}／{progress.total} 題 · 已答對{" "}
        {progress.correct} 題
      </p>
      <p
        className="question-save-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {saveStatus}
      </p>
      {stale ? (
        <Notice error>
          {message} <a href="#medications">回到我的藥品，重新產生說明</a>
        </Notice>
      ) : progress.passed && !reviewing ? (
        <div
          className="question-complete"
          ref={completionRef}
          tabIndex={-1}
          role="group"
          aria-label="理解測驗完成"
        >
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
        </div>
      ) : (
        <>
          <fieldset disabled={saving} className="question-fieldset">
            <legend ref={questionRef} tabIndex={-1}>
              <span className="question-position">
                第 {index + 1}／{progress.total} 題：
              </span>
              <span className="question-text">{q.q}</span>
            </legend>
            {q.learningObjective === "warning" && (
              <p className="muted">
                警語理解：{q.sourceSection}（抽查一個重點）
              </p>
            )}
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
                setSaveStatus(`正在保存第 ${index + 1} 題答案…`);
                try {
                  const response = await api<{
                    answers: Record<string, number>;
                    progress: LearningProgress;
                  }>("/learning/" + learningId + "/answers", "POST", {
                    answers: { [q.id]: selected },
                  });
                  focusSavedCompletion.current =
                    response.progress.passed && !progress.passed && !reviewing;
                  setAnswers(response.answers);
                  setSelection(undefined);
                  onProgress?.(response.progress);
                  const answer = response.progress.results.find(
                    (r) => r.id === q.id,
                  );
                  setSaveStatus(
                    response.progress.passed
                      ? "答案已保存。已完成全部測驗。"
                      : `第 ${index + 1} 題答案已保存。${
                          answer?.correct
                            ? index < result.quiz.length - 1
                              ? "答對了，可以繼續下一題。"
                              : "答對了，可以回看其他題目。"
                            : "請閱讀解說後再試一次。"
                        }`,
                  );
                } catch (e) {
                  const errorMessage =
                    e instanceof Error
                      ? e.message
                      : "暫時無法保存答案，請重試。";
                  setMessage(errorMessage);
                  setSaveStatus("答案尚未保存。" + errorMessage);
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
                disabled={
                  saving || !grade.correct || selected !== answers[q.id]
                }
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
  view = "all",
}: {
  result: GroundedResult;
  learningId?: string;
  medications?: Medication[];
  initialAnswers?: Record<string, number>;
  onProgress?: (progress: LearningProgress) => void;
  showQuiz?: boolean;
  view?: "all" | "reading" | "quiz";
}) {
  const evidenceRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLElement>(null);
  const warningsRef = useRef<HTMLElement>(null);
  const claimRefs = useRef(new Map<number, HTMLElement>());
  const sectionName = useId();
  const initialKey = JSON.stringify(initialAnswers || {});
  const [progress, setProgress] = useState(() =>
    learningProgress(result.quiz, initialAnswers),
  );
  useEffect(() => {
    setProgress(learningProgress(result.quiz, JSON.parse(initialKey)));
  }, [learningId, initialKey, result.quiz]);
  const showReading = view !== "quiz";
  const canShowQuiz = view !== "reading" && showQuiz && !!learningId;
  const hasQuiz = canShowQuiz && result.quiz.length > 0;
  const claims = result.claims.map((claim, index) => ({ claim, index }));
  const isPurpose = (claim: GroundedResult["claims"][number]) =>
    claim.category === "purpose" ||
    (!claim.category && claim.kind === "purpose") ||
    claim.kind === "source_exact_purpose";
  const isPersonal = (claim: GroundedResult["claims"][number]) =>
    !!(claim.profileRefs?.length || claim.sourceMentions?.length);
  const isWarning = (claim: GroundedResult["claims"][number]) =>
    !isPurpose(claim) &&
    (claim.category === "warning" ||
      claim.kind === "source_exact_safety" ||
      isPersonal(claim));
  const purposes = claims.filter(({ claim }) => isPurpose(claim));
  const otherReading = claims.filter(
    ({ claim }) => !isPurpose(claim) && !isWarning(claim),
  );
  const personalWarnings = claims.filter(
    ({ claim }) => isWarning(claim) && isPersonal(claim),
  );
  const generalWarnings = claims.filter(
    ({ claim }) => isWarning(claim) && !isPersonal(claim),
  );
  const goToQuiz = () =>
    focusReadingTarget(
      evidenceRef.current?.querySelector<HTMLElement>(".quiz") || null,
    );
  const quizAction = progress.passed
    ? "回看理解測驗"
    : progress.answered
      ? "繼續理解測驗"
      : "開始理解測驗";
  const renderClaim = ({
    claim: c,
    index,
  }: {
    claim: GroundedResult["claims"][number];
    index: number;
  }) => (
    <article
      className="claim reading-claim"
      key={index}
      tabIndex={-1}
      ref={(element) => {
        if (element) claimRefs.current.set(index, element);
        else claimRefs.current.delete(index);
      }}
    >
      <div className="claim-number">{String(index + 1).padStart(2, "0")}</div>
      <div>
        {c.category === "use" && <span className="tag">仿單一般用法</span>}
        {c.kind === "source_exact_purpose" &&
          c.citations.length === 1 &&
          c.text === c.citations[0].quote.trim() && (
            <span className="tag">仿單用途原文</span>
          )}
        {c.category === "warning" && (
          <span className="tag">警語與注意事項</span>
        )}
        <HealthReferences claim={c} />
        <p>{c.text}</p>
        <CitationDetails citations={c.citations} result={result} />
      </div>
    </article>
  );
  const labels = {
    supported: "已附仿單依據",
    not_found: "依現有仿單資料未發現記載",
    insufficient_data: "目前仿單資料不足",
    refused: "這個問題需要醫師或藥師判斷",
  };
  return (
    <div
      className={"evidence reading-view reading-view-" + view}
      ref={evidenceRef}
    >
      {showReading && (
        <div className="row spread reading-status">
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
      )}
      {showReading && result.status !== "supported" && (
        <Notice>
          {result.status === "refused"
            ? "目前提供仿單資訊整理。調整劑量、停藥、診斷與個人用藥判斷，請交由醫師或藥師協助。"
            : "你仍可保存藥品與已確認用法。沒有記載不代表沒有風險。"}
        </Notice>
      )}
      {showReading && (
        <>
          <nav className="reading-sections" aria-label="這份說明的閱讀段落">
            <button
              type="button"
              onClick={() => focusReadingTarget(readingRef.current)}
            >
              用途與用法
            </button>
            <button
              type="button"
              onClick={() => focusReadingTarget(warningsRef.current)}
            >
              完整警語
            </button>
            {hasQuiz && (
              <button type="button" onClick={goToQuiz}>
                理解測驗
              </button>
            )}
          </nav>
          {hasQuiz && (
            <div className="reading-quiz-entry">
              <div>
                <span className="reading-kicker">閱讀之後 · 理解測驗</span>
                <p>
                  共 {progress.total} 題 · 已答對 {progress.correct}{" "}
                  題。可隨時回來閱讀完整警語。
                </p>
              </div>
              <Button onClick={goToQuiz}>
                {quizAction} <ArrowRight size={17} />
              </Button>
            </div>
          )}
          <section
            id={learningId ? "reading-" + learningId : undefined}
            className="reading-section reading-use"
            ref={readingRef}
            tabIndex={-1}
            aria-labelledby={sectionName + "-reading"}
          >
            <div className="reading-section-heading">
              <span className="reading-step reading-kicker">01</span>
              <div>
                <h3 id={sectionName + "-reading"}>用途與用法</h3>
                <p>先了解藥品用途，再對照你核對過的藥袋用法。</p>
              </div>
            </div>
            <div className="reading-body">
              <div className="education-summary reading-context">
                <section className="education-card reading-purpose">
                  <h4 className="reading-note-label">藥品用途</h4>
                  {purposes.length ? (
                    purposes.map(renderClaim)
                  ) : (
                    <p className="muted">
                      目前沒有可引用的用途說明，請對照可用的仿單原文。
                    </p>
                  )}
                  <small>仿單用途不代表醫師為你開藥的原因。</small>
                </section>
                {medications && <EducationSummary medications={medications} />}
              </div>
              {otherReading.map(renderClaim)}
            </div>
          </section>
          <section
            id={learningId ? "warnings-" + learningId : undefined}
            className="reading-section reading-warnings"
            ref={warningsRef}
            tabIndex={-1}
            aria-labelledby={sectionName + "-warnings"}
          >
            <div className="reading-section-heading">
              <span className="reading-step reading-kicker">02</span>
              <div>
                <h3 id={sectionName + "-warnings"}>完整警語</h3>
                <p>保留已整理的警語全文；每項都可以展開對照自己的仿單依據。</p>
              </div>
            </div>
            <div className="reading-body">
              {result.safetyCoverage && result.status === "supported" && (
                <p className="fine" aria-label="警語與測驗範圍">
                  {result.safetyCoverage.status === "no_sections"
                    ? "這份已匯入仿單沒有獨立的警語或注意事項欄目；本次測驗確認藥品用途。"
                    : `已列出 ${result.safetyCoverage.coveredSectionCount} 個警語與注意事項欄目，其中 ${result.safetyCoverage.quizCoveredSectionCount} 個有理解題。題目只抽查各欄重點，請完整閱讀下列提醒。`}
                </p>
              )}
              <div
                className={
                  "personal-precautions reading-personal" +
                  (personalWarnings.length ? "" : " reading-personal-empty")
                }
              >
                {personalWarnings.length > 0 && <h4>對照你填寫資料的提醒</h4>}
                {personalWarnings.length ? (
                  personalWarnings.map(renderClaim)
                ) : (
                  <p className="muted">
                    目前沒有可確認與你健康資料相關的提醒，請繼續閱讀一般警語。這不代表沒有風險。
                  </p>
                )}
              </div>
              {generalWarnings.map(renderClaim)}
              {!personalWarnings.length && !generalWarnings.length && (
                <p className="muted">
                  目前沒有可列出的獨立警語內容；請以可用的仿單原文核對。
                </p>
              )}
              {result.followups?.map((f, i) => (
                <details className="reading-followup" key={i}>
                  <summary>{f.question}</summary>
                  {result.claims[f.claimIndex] && (
                    <Button
                      className="ghost"
                      onClick={() =>
                        focusReadingTarget(
                          claimRefs.current.get(f.claimIndex) || null,
                        )
                      }
                    >
                      回看相關說明 <ArrowDown size={15} />
                    </Button>
                  )}
                  <small>若這項情況與你有關，請向藥師確認。</small>
                </details>
              ))}
            </div>
          </section>
        </>
      )}
      {view === "quiz" && medications && (
        <div className="reading-quiz-context">
          <p className="reading-context-label reading-kicker">作答參考</p>
          <EducationSummary medications={medications} />
        </div>
      )}
      {hasQuiz && learningId && (
        <UnderstandingQuiz
          key={learningId}
          result={result}
          learningId={learningId}
          initialAnswers={initialAnswers}
          onProgress={(next) => {
            setProgress(next);
            onProgress?.(next);
          }}
        />
      )}
      {canShowQuiz &&
        result.status === "supported" &&
        result.quiz.length === 0 && (
          <Notice>
            目前可閱讀說明，暫無可用的理解題。用藥提醒與服藥紀錄仍可使用。
          </Notice>
        )}
      {showReading && result.rejectedCount > 0 && (
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
