import { ArrowLeft, ArrowRight, BookOpen, ScanLine } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Job, LearningRecord, Medication } from "../shared/schema";
import { learningProgress } from "../shared/learning";
import { doseLabel } from "../shared/medication";
import { Busy, Empty, Notice, SectionTitle, useData } from "./components";
import { Evidence, learningStateLabels } from "./Evidence";
import { Frequency } from "./medication-presentation";

const stages = ["recognition", "reading", "quiz"] as const;
const stageLabels = ["藥袋辨識", "仿單說明", "理解測驗"];

export function Demo() {
  const medications = useData<{ items: Medication[] }>("/medications");
  const learning = useData<{ items: LearningRecord[] }>("/learning");
  const jobs = useData<{ items: Job[] }>("/jobs");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const records = (learning.data?.items || []).filter(
    (r) => r.medicationIds.length === 1,
  );
  const savedJobFor = (r: LearningRecord) =>
    jobs.data?.items.find(
      (j) =>
        j.kind === "recognition" &&
        j.status === "succeeded" &&
        Object.values(j.savedMedications || {}).some((m) =>
          r.medicationIds.includes(m.id),
        ),
    );
  const recordId = params.get("record");
  const record = recordId
    ? records.find((r) => r.id === recordId)
    : records.find(savedJobFor) || records[0];
  const meds = (medications.data?.items || []).filter((m) =>
    record?.medicationIds.includes(m.id),
  );
  const job = record && savedJobFor(record);
  const requestedStep = stages.indexOf(
    params.get("step") as (typeof stages)[number],
  );
  const step = requestedStep < 0 ? 0 : requestedStep;
  const link = (id: string, stage = stages[step]) =>
    `#demo?record=${encodeURIComponent(id)}&step=${stage}`;
  const progress =
    record &&
    (record.progress || learningProgress(record.result.quiz, record.answers));
  const loading = medications.loading || learning.loading || jobs.loading;
  const focusStage = params.has("step") || !!recordId;
  const stageHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (loading || !record || !focusStage) return;
    const frame = requestAnimationFrame(() => {
      stageHeading.current?.focus({ preventScroll: true });
      stageHeading.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, record?.id, step, focusStage]);
  const error = medications.error || learning.error;
  const name = (r: LearningRecord) =>
    (medications.data?.items || [])
      .filter((m) => r.medicationIds.includes(m.id))
      .map((m) => m.name)
      .join("、") || "藥品說明";

  return (
    <>
      <SectionTitle
        eyebrow="看見完整流程"
        title="研討會展示"
        action={
          <a className="btn secondary" href="#home">
            <ArrowLeft size={17} />
            返回日常使用
          </a>
        }
      >
        選一款藥，從辨識結果一路走到理解測驗。
      </SectionTitle>
      <div className="demo-saved-note">
        <span className="tag">已保存結果</span>
        <p>
          此入口讀取已保存的辨識與仿單說明；切換步驟不會重新呼叫
          AI。測驗作答會保存到這個帳號。
        </p>
      </div>
      {error && <Notice error>{error}</Notice>}
      {jobs.error && <Notice error>暫時無法讀取辨識紀錄：{jobs.error}</Notice>}
      {loading ? (
        <Busy />
      ) : !record ? (
        <section className="card">
          <Empty
            title={recordId ? "找不到這份展示內容" : "還沒有可展示的藥品說明"}
            action={
              <a
                className="btn primary"
                href={recordId ? "#demo" : "#add?from=demo"}
              >
                {recordId ? "返回展示入口" : "從辨識藥袋開始"}
              </a>
            }
          >
            {recordId
              ? "請重新選擇已保存的內容。"
              : "完成辨識、核對用法並產生仿單說明後，即可在這裡走完整個流程。"}
          </Empty>
        </section>
      ) : (
        <>
          <section className="card demo-selector">
            <label htmlFor="demo-record">選擇展示藥品</label>
            <select
              id="demo-record"
              value={record.id}
              onChange={(e) => {
                location.hash = link(e.target.value);
              }}
            >
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {name(r)}
                </option>
              ))}
            </select>
            <div className="demo-facts">
              <span>{record.result.claims.length} 項仿單說明</span>
              <span>{record.result.quiz.length} 題理解測驗</span>
              {progress && (
                <span>
                  測驗{learningStateLabels[progress.status]} · 已答對{" "}
                  {progress.correct} 題
                </span>
              )}
            </div>
          </section>
          <nav className="demo-stage-nav" aria-label="展示步驟">
            {stages.map((stage, i) => (
              <a
                key={stage}
                href={link(record.id, stage)}
                aria-current={step === i ? "step" : undefined}
              >
                {i + 1}. {stageLabels[i]}
              </a>
            ))}
          </nav>
          <section className="demo-stage" aria-label={stageLabels[step]}>
            <div className="demo-stage-heading">
              <span className="eyebrow">步驟 0{step + 1}</span>
              <h2 ref={stageHeading} tabIndex={-1}>
                {stageLabels[step]}
              </h2>
            </div>
            {step === 0 ? (
              <div className="card demo-recognition">
                <div className="row spread">
                  <h3>{name(record)}</h3>
                  <span className="tag">已保存辨識結果</span>
                </div>
                <p>
                  對照辨識文字與已確認的藥品資料。辨識結果需要由使用者核對藥名與用法。
                </p>
                {job ? (
                  <Notice>這款藥品有對應的已完成辨識紀錄。</Notice>
                ) : (
                  <Notice>
                    這款藥品沒有對應的已保存辨識紀錄，可繼續查看已保存的說明，或另拍一張藥袋。
                  </Notice>
                )}
                {meds.map((med) => (
                  <div className="demo-medication" key={med.id}>
                    <dl className="demo-med-facts">
                      <div>
                        <dt>核對狀態</dt>
                        <dd>{med.confirmed ? "使用者已確認" : "尚未確認"}</dd>
                      </div>
                      <div>
                        <dt>規格／劑型</dt>
                        <dd>
                          {[med.strength, med.form]
                            .filter(Boolean)
                            .join(" · ") || "未填寫"}
                        </dd>
                      </div>
                      <div>
                        <dt>每次用量</dt>
                        <dd>{doseLabel(med) || "未填寫"}</dd>
                      </div>
                      <div>
                        <dt>用法頻次</dt>
                        <dd>
                          <Frequency raw={med.frequencyRaw} />
                        </dd>
                      </div>
                    </dl>
                    <details>
                      <summary>查看已保存的藥袋辨識文字</summary>
                      <p className="recognition-literal">
                        {med.rawText || "這筆藥品沒有保存辨識文字。"}
                      </p>
                    </details>
                  </div>
                ))}
                <div className="row wrap">
                  {job && (
                    <a
                      className="btn secondary"
                      href={`#add?recognition=${encodeURIComponent(job.id)}&from=demo&record=${encodeURIComponent(record.id)}`}
                    >
                      開啟辨識紀錄 <ArrowRight size={16} />
                    </a>
                  )}
                  <a
                    className="btn ghost"
                    href={`#add?from=demo&record=${encodeURIComponent(record.id)}`}
                  >
                    <ScanLine size={17} />
                    現場拍一張藥袋
                  </a>
                </div>
              </div>
            ) : (
              <div
                className="card demo-evidence"
                key={record.id + stages[step]}
              >
                <h3 className="demo-medicine-title">
                  <BookOpen size={21} />
                  {name(record)}
                </h3>
                <Evidence
                  view={step === 1 ? "reading" : "quiz"}
                  result={record.result}
                  learningId={record.id}
                  medications={meds}
                  initialAnswers={record.answers}
                  onProgress={() => {
                    void learning.refresh();
                  }}
                />
              </div>
            )}
          </section>
          <div className="demo-bottom-actions">
            {step > 0 && (
              <a
                className="btn secondary"
                href={link(record.id, stages[step - 1])}
              >
                <ArrowLeft size={17} />
                上一步：{stageLabels[step - 1]}
              </a>
            )}
            {step < 2 ? (
              <a
                className="btn primary"
                href={link(record.id, stages[step + 1])}
              >
                下一步：{stageLabels[step + 1]}
                <ArrowRight size={17} />
              </a>
            ) : (
              <a
                className="btn secondary"
                href={`#learning?record=${encodeURIComponent(record.id)}&section=reading&from=demo`}
              >
                回到完整說明
              </a>
            )}
          </div>
        </>
      )}
    </>
  );
}
