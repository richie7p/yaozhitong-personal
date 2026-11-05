import { useEffect, useRef, useState } from "react";
import { BookOpen, Camera, Upload } from "lucide-react";
import type {
  DrugExplanationRequest,
  DrugExplanationResult,
} from "../shared/drug-explanation";
import { api, fileBase64, submitJob } from "./api";
import { Button, Field, JobNotice, Notice, SectionTitle } from "./components";
import { DrugExplanation } from "./DrugExplanation";
import { recognitionPhotoType } from "./photo-input";
import { PrivacyLink } from "./Privacy";

export function QuickMedication({
  recognitionId,
}: {
  recognitionId?: string | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [recognition, setRecognition] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    id: string;
    result: DrugExplanationResult;
  } | null>(null);
  const [query, setQuery] = useState({ name: "", strength: "", form: "" });
  const [manualOpen, setManualOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const manualName = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const version = useRef(0);
  const running = useRef(false);

  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!result) return;
    resultHeading.current?.focus({ preventScroll: true });
    resultHeading.current?.scrollIntoView({ block: "start" });
  }, [result?.id]);

  function checkedRecognition(job: any) {
    if (
      job.kind !== "recognition" ||
      job.status !== "succeeded" ||
      !Array.isArray(job.result?.medications)
    )
      throw new Error("這筆照片還沒有可讀取的辨識結果，請到處理紀錄查看進度。");
    return job;
  }
  useEffect(() => {
    if (!recognitionId) return;
    const current = ++version.current;
    running.current = true;
    setRecognition(null);
    setResult(null);
    setError("");
    setFile(null);
    setBusy("正在讀取照片辨識結果…");
    api("/jobs/" + encodeURIComponent(recognitionId))
      .then((job) => {
        if (version.current === current)
          setRecognition(checkedRecognition(job));
      })
      .catch((cause) => {
        if (version.current === current) setError(cause.message);
      })
      .finally(() => {
        if (version.current === current) {
          running.current = false;
          setBusy("");
        }
      });
  }, [recognitionId]);

  async function choosePhoto(element: HTMLInputElement) {
    const next = element.files?.[0];
    if (!next || running.current) return;
    const current = ++version.current;
    running.current = true;
    setBusy("正在檢查照片…");
    setError("");
    setFile(null);
    setRecognition(null);
    setResult(null);
    try {
      await recognitionPhotoType(next);
      if (current === version.current) setFile(next);
    } catch (cause: any) {
      if (current === version.current) {
        element.value = "";
        setError(cause.message);
      }
    } finally {
      if (current === version.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  function pickPhoto(camera: boolean) {
    if (!input.current || running.current) return;
    if (camera) input.current.setAttribute("capture", "environment");
    else input.current.removeAttribute("capture");
    input.current.value = "";
    input.current.click();
  }
  async function scan() {
    if (!file || running.current) return;
    const current = ++version.current;
    running.current = true;
    setBusy("正在上傳藥品照片…");
    setError("");
    setRecognition(null);
    setResult(null);
    const progress = (text: string) => {
      if (version.current === current) setBusy(text);
    };
    try {
      const mediaType = await recognitionPhotoType(file);
      const image = await fileBase64(file);
      if (current !== version.current) return;
      const job = await submitJob(
        "/recognitions",
        { image, mediaType },
        progress,
      );
      if (current === version.current) setRecognition(checkedRecognition(job));
    } catch (cause: any) {
      if (current === version.current) setError(cause.message);
    } finally {
      if (current === version.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  async function explain(request: DrugExplanationRequest) {
    if (running.current) return;
    const current = ++version.current;
    running.current = true;
    setBusy("正在搜尋可靠來源並整理藥品資訊…");
    setError("");
    setResult(null);
    try {
      const job = await submitJob("/explanations", request, (text) => {
        if (current === version.current) setBusy(text);
      });
      if (current !== version.current) return;
      if (
        job.explanationUpdateRequired ||
        job.result?.mode !== "general_information"
      )
        throw new Error("這份解說需要重新查詢，請再試一次。");
      setResult(job);
    } catch (cause: any) {
      if (current === version.current) setError(cause.message);
    } finally {
      if (current === version.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  function correct(row: any) {
    setQuery({
      name: row.name || "",
      strength: row.strength || "",
      form: row.form || "",
    });
    setManualOpen(true);
    requestAnimationFrame(() => {
      manualName.current?.focus();
      manualName.current?.scrollIntoView({ block: "center" });
    });
  }
  return (
    <>
      <SectionTitle eyebrow="拍照查藥" title="一般藥品快速查詢">
        拍清楚包裝文字，AI 會幫你查詢基本用藥資訊，包括用途、注意事項、副作用與保存方式。不必先建檔或確認個人用法。
      </SectionTitle>
      <p className="fine">
        本站尚未收錄官方仿單時，也能由 AI 查詢政府與醫療機構資料，並附上來源。
      </p>
      <p className="fine">
        查詢結果保留在「處理紀錄與恢復」，不會自動加入「我的藥品」。照片辨識使用
        1 次 AI 額度，每款藥品的解說另使用 1 次；直接輸入藥名查詢使用 1 次。
      </p>
      {error && <Notice error>{error}</Notice>}
      {busy && <JobNotice text={busy} />}
      <section
        className="card quick-drug-capture"
        aria-label="一般藥品照片查詢"
      >
        <h2>拍下藥品包裝</h2>
        <p>
          藥盒、瓶身、鋁箔包裝、藥袋或藥膏管身都可以。讓完整藥名、含量或濃度與劑型清楚入鏡；不需要有每天使用次數。
        </p>
        <p className="fine">
          有姓名、身分證號或識別條碼時請先遮住。只有散裝藥丸的外觀，無法可靠確認藥名；請補拍有文字的包裝。
        </p>
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          aria-label="一般藥品照片"
          accept="image/jpeg,image/png"
          disabled={!!busy}
          onChange={(event) => void choosePhoto(event.currentTarget)}
        />
        <div className="row wrap">
          <Button
            className="secondary"
            disabled={!!busy}
            onClick={() => pickPhoto(true)}
          >
            <Camera size={18} />
            開啟相機拍攝
          </Button>
          <Button
            className="secondary"
            disabled={!!busy}
            onClick={() => pickPhoto(false)}
          >
            <Upload size={18} />
            上傳照片
          </Button>
        </div>
        {preview && (
          <figure className="capture-preview">
            <img src={preview} alt="本次一般藥品照片，請確認文字清楚" />
            <figcaption>{file?.name}</figcaption>
          </figure>
        )}
        <p className="fine">
          支援 JPEG／PNG，8 MB
          內。辨識結束後會清除原照片，尚未清除的暫存依排程處理；請勿放入個人識別資料。
        </p>
        <Button className="primary" disabled={!file || !!busy} onClick={scan}>
          辨識藥品照片
        </Button>
        <p className="fine">
          <PrivacyLink />
        </p>
      </section>
      {recognition && (
        <section className="quick-drug-results" aria-label="一般藥品辨識結果">
          <h2>選擇想了解的藥品</h2>
          <p>
            以下是照片文字的辨識結果，尚未確認完整產品身分。你可以直接查詢 AI
            藥品解說；若藥名不正確，先修正文字。
          </p>
          {recognition.result.guidance && (
            <Notice>{recognition.result.guidance}</Notice>
          )}
          {!recognition.result.medications.length && (
            <Notice>
              還沒有讀到可查詢的藥名，請補拍包裝，或在下方直接輸入完整藥名。
            </Notice>
          )}
          {recognition.result.medications.map((row: any, index: number) => (
            <article
              className="quick-drug-row"
              key={recognition.id + ":" + index}
            >
              <h3>{row.name || "藥名未讀清楚"}</h3>
              <p>
                {[row.strength, row.form].filter(Boolean).join("、") ||
                  "含量與劑型未讀清楚"}
              </p>
              <div className="row wrap">
                <Button
                  className="primary"
                  disabled={!!busy || !row.name?.trim()}
                  onClick={() =>
                    explain({
                      recognitionId: recognition.id,
                      medicationIndex: index,
                    })
                  }
                >
                  <BookOpen size={18} />
                  AI 藥品解說
                </Button>
                <Button
                  className="ghost"
                  disabled={!!busy}
                  onClick={() => correct(row)}
                >
                  修正藥名再查詢
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}
      <details
        className="card quick-drug-manual"
        open={manualOpen}
        onToggle={(event) => setManualOpen(event.currentTarget.open)}
      >
        <summary>直接輸入或修正藥名</summary>
        <p>
          請照包裝填寫，不需輸入姓名、個人用量或病史。只有「感冒藥」等描述時，無法確定是哪一款藥。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (query.name.trim()) void explain({ query });
          }}
        >
          <div className="full-grid">
            <Field label="查詢藥名">
              <input
                ref={manualName}
                required
                maxLength={150}
                value={query.name}
                disabled={!!busy}
                onChange={(event) =>
                  setQuery({ ...query, name: event.target.value })
                }
                placeholder="包裝上的完整藥名"
              />
            </Field>
          </div>
          <Field label="含量或濃度（選填）">
            <input
              maxLength={80}
              value={query.strength}
              disabled={!!busy}
              onChange={(event) =>
                setQuery({ ...query, strength: event.target.value })
              }
              placeholder="照包裝文字填寫"
            />
          </Field>
          <Field label="劑型（選填）">
            <input
              maxLength={50}
              value={query.form}
              disabled={!!busy}
              onChange={(event) =>
                setQuery({ ...query, form: event.target.value })
              }
              placeholder="例如乳膏、錠劑、糖漿"
            />
          </Field>
          <div className="full-grid">
            <Button
              type="submit"
              className="primary"
              disabled={!!busy || !query.name.trim()}
            >
              查詢藥品解說
            </Button>
          </div>
        </form>
      </details>
      {result && (
        <section className="card quick-drug-result">
          <h2 ref={resultHeading} tabIndex={-1}>
            AI 藥品解說
          </h2>
          <DrugExplanation result={result.result} />
          <a className="text-link" href="#jobs">
            到處理紀錄查看這次查詢
          </a>
        </section>
      )}
      <p className="fine">
        若需要持續記錄用藥與提醒，可切換至「慢性處方箋／長期用藥」。快速查詢不提供個人診斷、用量或自行停藥建議。
      </p>
    </>
  );
}
