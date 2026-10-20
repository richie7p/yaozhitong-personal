import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Plus,
  Search,
  ScanLine,
  ArrowRight,
  Save,
  BookOpen,
  Trash2,
  CalendarClock,
  MessageCircle,
  Send,
  X,
} from "lucide-react";
import { api, fileBase64, submitJob } from "./api";
import { chatDraftSession } from "./chat-draft";
import { recognitionPhotoType } from "./photo-input";
import { recognitionDraftFlags } from "./recognition-draft";
import {
  Button,
  Busy,
  Empty,
  JobNotice,
  Field,
  Notice,
  SectionTitle,
  useData,
} from "./components";
import { Evidence, learningStateLabels } from "./Evidence";
import { FlowSteps } from "./UIFlow";
import { learningProgress } from "../shared/learning";
import { doseLabel } from "../shared/medication";
import type {
  GroundedResult,
  LearningProgress,
  LearningRecord,
  Medication,
} from "../shared/schema";
const blank = {
  name: "",
  licenseNo: null as string | null,
  strength: "",
  form: "",
  doseAmount: null as number | null,
  doseUnit: "",
  doseText: "",
  frequencyRaw: "",
  route: "",
  rawText: "",
  durationDays: null as number | null,
  instructions: "",
  confirmed: false,
  prn: false,
};
export function MedicationForm({
  initial = blank,
  onSave,
}: {
  initial?: any;
  onSave: (m: any) => Promise<void>;
}) {
  const [m, setM] = useState(() => {
      const value = { ...blank, ...initial };
      for (const key of [
        "strength",
        "form",
        "doseUnit",
        "doseText",
        "frequencyRaw",
        "route",
      ])
        value[key] ??= "";
      return value;
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [errorCode, setErrorCode] = useState("");
  const set = (key: string, v: unknown) => setM({ ...m, [key]: v });
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(m);
        } catch (e: any) {
          setError(e.message);
          setErrorCode(e.code || "");
        } finally {
          setBusy(false);
        }
      }}
      className="form-grid"
    >
      <Field label="藥品名稱">
        <input
          required
          value={m.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="依藥袋填寫完整藥名"
        />
      </Field>
      <Field label="許可證字號">
        <input readOnly value={m.licenseNo || "尚未匹配，可先存為草稿"} />
      </Field>
      <Field label="含量／規格">
        <input
          value={m.strength}
          onChange={(e) => set("strength", e.target.value)}
          placeholder="照藥袋抄錄，不確定可留白"
        />
      </Field>
      <Field label="劑型">
        <input
          value={m.form}
          onChange={(e) => set("form", e.target.value)}
          placeholder="例如：膜衣錠"
        />
      </Field>
      <Field label="每次劑量">
        <input
          type="number"
          min="0.01"
          step="any"
          value={m.doseAmount ?? ""}
          onChange={(e) =>
            setM({
              ...m,
              doseAmount: e.target.value ? Number(e.target.value) : null,
              doseText: "",
            })
          }
          placeholder="待確認"
        />
      </Field>
      <Field label="劑量單位">
        <input
          value={m.doseUnit}
          onChange={(e) =>
            setM({ ...m, doseUnit: e.target.value, doseText: "" })
          }
          placeholder="例如：錠、包、毫升"
        />
      </Field>
      <Field label="每次用量原文（非數字用量時填寫）">
        <input
          value={m.doseText || ""}
          onChange={(e) =>
            setM({
              ...m,
              doseText: e.target.value,
              ...(e.target.value ? { doseAmount: null, doseUnit: "" } : {}),
            })
          }
          placeholder="例如藥袋寫「適量」；請照原文填寫"
        />
      </Field>
      <Field label="頻次原文">
        <input
          value={m.frequencyRaw}
          onChange={(e) => set("frequencyRaw", e.target.value)}
          placeholder="例如：BID PC／一天兩次飯後"
        />
      </Field>
      <Field label="給藥途徑">
        <input
          value={m.route}
          onChange={(e) => set("route", e.target.value)}
          placeholder="依藥袋填寫"
        />
      </Field>
      <div className="full-grid">
        {m.rawText && (
          <details>
            <summary>原始辨識文字</summary>
            <p>{m.rawText}</p>
          </details>
        )}
        <Field label="療程天數（可留白）">
          <input
            type="number"
            min="1"
            value={m.durationDays ?? ""}
            onChange={(e) =>
              set(
                "durationDays",
                e.target.value ? Number(e.target.value) : null,
              )
            }
          />
        </Field>
        <Field label="用法備註">
          <textarea
            value={m.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="保留醫師或藥師交代的用法"
          />
        </Field>
      </div>
      <label className="choice">
        <input
          type="checkbox"
          checked={m.prn}
          onChange={(e) => set("prn", e.target.checked)}
        />
        需要時才使用（不排定時提醒）
      </label>
      <label className="choice">
        <input
          type="checkbox"
          checked={m.confirmed}
          onChange={(e) => set("confirmed", e.target.checked)}
        />
        我已對照藥袋確認藥品與用法
      </label>
      <div className="full-grid">
        {error && <Notice error>{error}</Notice>}
        {["already_saved", "recognition_saved_conflict"].includes(
          errorCode,
        ) && (
          <a className="btn secondary" href="#medications">
            前往我的藥品確認
          </a>
        )}
        <Button type="submit" className="primary" disabled={busy}>
          <Save size={17} />
          {busy ? "儲存中…" : m.confirmed ? "確認並儲存藥品" : "儲存草稿"}
        </Button>
      </div>
    </form>
  );
}
export function AddMedication({
  recognitionId = null,
}: {
  recognitionId?: string | null;
}) {
  const [tab, setTab] = useState("photo"),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [draft, setDraft] = useState<any>(null),
    [recognized, setRecognized] = useState<
      { key: string; index: number; medication: any }[]
    >([]),
    [selectedRecognition, setSelectedRecognition] = useState<string | null>(
      null,
    ),
    [savedNames, setSavedNames] = useState<string[]>([]),
    [saving, setSaving] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [file, setFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const photoSelectionVersion = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [recognitionJob, setRecognitionJob] = useState<string | null>(null);
  const fromDemo =
    new URLSearchParams(location.hash.split("?")[1] || "").get("from") ===
    "demo";
  useEffect(() => {
    if (!file) {
      setPhotoPreview("");
      return;
    }
    const preview = URL.createObjectURL(file);
    setPhotoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  useEffect(() => {
    if (!draft && tab !== "manual") return;
    reviewHeading.current?.focus({ preventScroll: true });
    reviewHeading.current?.scrollIntoView({ block: "start" });
  }, [draft, tab]);
  function loadRecognition(j: any) {
    if (
      (j.kind && j.kind !== "recognition") ||
      j.status !== "succeeded" ||
      !Array.isArray(j.result?.medications)
    )
      throw new Error("這筆辨識尚未完成，請到 AI 處理紀錄查看進度。");
    setRecognitionJob(j.id);
    setRecognized(
      j.result.medications.flatMap((medication: any, index: number) =>
        j.savedMedications?.[String(index)]
          ? []
          : [{ key: `${j.id}-${index}`, index, medication }],
      ),
    );
    setSavedNames(
      Object.values(j.savedMedications || {}).map((m: any) => m.name),
    );
    if (j.result.guidance || j.result.status === "failed")
      setError(j.result.guidance || "無法辨識，請重新拍攝。");
  }
  useEffect(() => {
    if (!recognitionId) return;
    let live = true;
    setBusy("正在讀取已完成的辨識…");
    api("/jobs/" + encodeURIComponent(recognitionId))
      .then((j) => {
        if (live) loadRecognition(j);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy("");
      });
    return () => {
      live = false;
    };
  }, [recognitionId]);
  async function search() {
    setBusy("搜尋官方藥品索引…");
    setError("");
    try {
      setResults(
        (await api("/drugs/search?q=" + encodeURIComponent(query))).items,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function scan() {
    if (!file) return;
    setBusy("正在上傳藥袋…");
    setError("");
    setRecognized([]);
    setDraft(null);
    setSelectedRecognition(null);
    setSavedNames([]);
    setRecognitionJob(null);
    try {
      const mediaType = await recognitionPhotoType(file);
      const j = await submitJob(
        "/recognitions",
        { image: await fileBase64(file), mediaType },
        setBusy,
      );
      loadRecognition(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function choosePhoto(input: HTMLInputElement) {
    const chosen = input.files?.[0] || null;
    if (!chosen) return;
    const version = ++photoSelectionVersion.current;
    setFile(null);
    setPhotoPreview("");
    setRecognized([]);
    setDraft(null);
    setSelectedRecognition(null);
    setSavedNames([]);
    setRecognitionJob(null);
    setError("");
    setBusy("正在檢查照片…");
    try {
      await recognitionPhotoType(chosen);
      if (version !== photoSelectionVersion.current) return;
      setFile(chosen);
    } catch (e: any) {
      if (version !== photoSelectionVersion.current) return;
      input.value = "";
      setError(e.message);
    } finally {
      if (version === photoSelectionVersion.current) setBusy("");
    }
  }
  function openPhotoPicker(camera: boolean) {
    const input = photoInput.current;
    if (!input || saving || busy) return;
    // Apply the hint in the same user gesture, before opening the native picker.
    // Browsers without capture support retain their normal file picker.
    if (camera) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.value = "";
    input.click();
  }
  const select = (d: any) =>
    setDraft({
      ...blank,
      name: d.nameZh,
      licenseNo: d.licenseNo,
      strength: d.strength,
      form: d.form,
    });
  return (
    <>
      <SectionTitle eyebrow="藥品建檔" title="新增藥品">
        拍攝藥袋或搜尋藥名，再核對藥名與用法。
      </SectionTitle>
      {tab === "photo" && (
        <FlowSteps
          steps={["選擇藥袋", "辨識結果", "核對用法"]}
          current={draft ? 2 : recognized.length || recognitionJob ? 1 : 0}
        />
      )}
      <div className="tabs">
        {[
          ["photo", "拍攝藥袋"],
          ["search", "搜尋藥名"],
          ["manual", "手動建檔"],
        ].map(([id, t]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            disabled={saving || !!busy}
            onClick={() => {
              setTab(id);
              setDraft(null);
              setSelectedRecognition(null);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {error && <Notice error>{error}</Notice>}
      {error && (
        <a className="btn secondary" href="#jobs">
          查看 AI 處理紀錄
        </a>
      )}
      {busy && <Busy text={busy} />}
      {tab === "photo" && savedNames.length > 0 && recognized.length === 0 && (
        <Notice>
          這份辨識的 {savedNames.length} 筆資料已儲存。
          <a href="#medications">查看我的藥品</a>
        </Notice>
      )}
      {tab === "photo" && savedNames.length > 0 && recognized.length > 0 && (
        <Notice>
          已儲存：{savedNames.join("、")}。還有 {recognized.length} 筆待核對。
          <a href="#medications">查看我的藥品</a>
        </Notice>
      )}
      {tab === "photo" && !draft && (
        <section className="card capture-station" aria-label="藥袋辨識工作區">
          <div className="upload-area capture-workspace">
            <div className="capture-station-heading">
              <ScanLine size={32} aria-hidden="true" />
              <h2>藥袋照片</h2>
            </div>
            <p className="capture-instructions">
              遮住姓名與身分證號，讓藥名、用法清楚入鏡。請平放藥袋，避開反光。
            </p>
            <div className="row">
              <Button
                className="secondary"
                disabled={saving || !!busy}
                onClick={() => openPhotoPicker(true)}
              >
                {file ? "重新拍攝" : "開啟相機拍攝"}
              </Button>
              <Button
                className="secondary"
                disabled={saving || !!busy}
                onClick={() => openPhotoPicker(false)}
              >
                {file ? "更換照片" : "上傳照片"}
              </Button>
            </div>
            <input
              ref={photoInput}
              className="visually-hidden"
              type="file"
              aria-label="藥袋照片"
              accept="image/jpeg,image/png"
              tabIndex={-1}
              disabled={saving || !!busy}
              onChange={(e) => void choosePhoto(e.currentTarget)}
            />
            {photoPreview && (
              <figure className="capture-preview">
                <img
                  src={photoPreview}
                  alt="本次選擇的藥袋照片，請確認文字清晰"
                />
                <figcaption>{file?.name}</figcaption>
              </figure>
            )}
            <Button
              className="primary capture-submit"
              disabled={!file || !!busy || saving}
              onClick={scan}
            >
              開始辨識 <ArrowRight size={17} />
            </Button>
            <small className="capture-format">
              限 JPEG／PNG，8 MB 以內；圖片完成辨識後刪除。
              相機未開啟時，可先用手機拍照，再選擇「上傳照片」。
            </small>
          </div>
          {recognized.length > 0 && (
            <h2 id="capture-results" tabIndex={-1}>
              辨識結果：請選擇要核對的藥品
            </h2>
          )}
          {recognized.map(({ key, medication: m }) => (
            <div className="card small capture-result-sheet" key={key}>
              <div className="row spread">
                <h3>{m.name}</h3>
                <span className="tag amber">請逐項確認</span>
              </div>
              <p>{m.rawText}</p>
              <Button
                disabled={saving}
                onClick={() => {
                  setSelectedRecognition(key);
                  setDraft({
                    ...blank,
                    ...m,
                    licenseNo: null,
                    ...recognitionDraftFlags(m.frequencyRaw),
                  });
                }}
              >
                編輯這筆資料
              </Button>
              {m.candidates?.map((c: any) => (
                <button
                  className="search-result capture-candidate"
                  key={c.licenseNo}
                  disabled={saving}
                  onClick={() => {
                    setSelectedRecognition(key);
                    setDraft({
                      ...blank,
                      ...m,
                      name: c.nameZh,
                      licenseNo: c.licenseNo,
                      strength: c.strength,
                      form: c.form,
                      ...recognitionDraftFlags(m.frequencyRaw),
                    });
                  }}
                >
                  <div>
                    <strong>{c.nameZh}</strong>
                    <small>{c.licenseNo}</small>
                    <small className="capture-candidate-details">
                      含量／規格：{c.strength || "未提供"} · 劑型：
                      {c.form || "未提供"}
                    </small>
                    {c.revoked && (
                      <span className="tag amber">許可證已註銷</span>
                    )}
                  </div>
                  <span className="tag">
                    {c.hasLeaflet ? "有仿單" : "未收錄仿單"}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </section>
      )}
      {tab === "search" && !draft && (
        <section className="card">
          <form
            className="search-bar"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <Search size={20} />
            <input
              id="capture-search"
              aria-label="搜尋藥名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="輸入中文、英文藥名或許可證字號"
              minLength={2}
              required
            />
            <Button type="submit" className="primary" disabled={!!busy}>
              搜尋
            </Button>
          </form>
          {results.map((d) => (
            <button
              className="search-result"
              key={d.licenseNo}
              onClick={() => select(d)}
            >
              <div>
                <strong>{d.nameZh}</strong>
                <small>
                  {d.nameEn} · {d.licenseNo}
                </small>
                <small className="capture-candidate-details">
                  含量／規格：{d.strength || "未提供"} · 劑型：
                  {d.form || "未提供"}
                </small>
                {d.revoked && <span className="tag amber">許可證已註銷</span>}
              </div>
              <span className={"tag " + (d.hasLeaflet ? "green" : "")}>
                {d.hasLeaflet ? "可查看仿單" : "未收錄仿單"}
              </span>
              <Plus size={18} />
            </button>
          ))}
          {!results.length && (
            <Empty title="找到手上的那一款藥">
              請核對完整名稱、含量與劑型。資料庫尚無仿單的藥品也可以記錄。
            </Empty>
          )}
        </section>
      )}
      {(tab === "manual" || draft) && (
        <section className="card capture-review">
          <div className="row spread">
            <h2 ref={reviewHeading} tabIndex={-1}>
              核對藥品與用法
            </h2>
            {draft && (
              <Button
                className="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setSelectedRecognition(null);
                  window.requestAnimationFrame(() => {
                    document
                      .getElementById(
                        tab === "photo" ? "capture-results" : "capture-search",
                      )
                      ?.focus();
                  });
                }}
              >
                {tab === "photo" ? "返回辨識結果" : "返回搜尋結果"}
              </Button>
            )}
          </div>
          <Notice>
            沒有辨識到的欄位保持空白。請依藥袋或向藥師確認，切勿自行推測。
          </Notice>
          <MedicationForm
            key={(selectedRecognition || "") + JSON.stringify(draft)}
            initial={draft || blank}
            onSave={async (m) => {
              setSaving(true);
              try {
                const row = recognized.find(
                  (item) => item.key === selectedRecognition,
                );
                const saved = await api<Medication>(
                  tab === "photo" && recognitionJob && row
                    ? `/recognitions/${encodeURIComponent(recognitionJob)}/medications/${row.index}`
                    : "/medications",
                  "POST",
                  m,
                );
                if (tab === "photo" && selectedRecognition) {
                  const remaining = recognized.filter(
                    (item) => item.key !== selectedRecognition,
                  );
                  setRecognized(remaining);
                  setSelectedRecognition(null);
                  setDraft(null);
                  if (remaining.length > 0) {
                    setSavedNames((names) => [...names, m.name]);
                    window.requestAnimationFrame(() => {
                      document.getElementById("capture-results")?.focus();
                    });
                    return;
                  }
                }
                location.hash = fromDemo
                  ? `medications?from=demo&medication=${encodeURIComponent(saved.id)}`
                  : "medications";
              } finally {
                setSaving(false);
              }
            }}
          />
        </section>
      )}
    </>
  );
}
export function Medications() {
  const { data, error, loading, refresh } = useData("/medications");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const fromDemo = params.get("from") === "demo";
  const demoMedicationId = fromDemo ? params.get("medication") : null;
  const demoMedication = data?.items.find(
    (m: Medication) => m.id === demoMedicationId,
  );
  const [edit, setEdit] = useState<any>(null),
    [schedule, setSchedule] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(""),
    [result, setResult] = useState<LearningRecord | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!result) return;
    resultHeading.current?.focus({ preventScroll: true });
    resultHeading.current?.scrollIntoView({ block: "start" });
  }, [result?.id]);
  useEffect(() => {
    if (!demoMedicationId || loading) return;
    const heading = document.getElementById(`medication-${demoMedicationId}`);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "start" });
  }, [demoMedicationId, loading]);
  async function explain(m: any) {
    setBusy("正在讀取已保存的仿單說明…");
    setMessage("");
    setResult(null);
    try {
      const saved = await api<{ items: LearningRecord[] }>("/learning");
      const existing = saved.items.find(
        (r) =>
          r.medicationIds.length === 1 &&
          r.medicationIds[0] === m.id &&
          r.result.status === "supported",
      );
      if (existing) {
        setResult(existing);
        return;
      }
      const j = await submitJob("/bundles", { medicationIds: [m.id] }, setBusy);
      const current = await api<{ items: LearningRecord[] }>("/learning");
      const row = current.items.find((r) => r.id === j.id);
      if (!row) throw new Error("內容已更新，請重新產生仿單說明。");
      setResult(row);
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <SectionTitle
        eyebrow="藥品檔案"
        title="我的藥品"
        action={
          <a className="btn primary" href="#add">
            <Plus size={18} />
            新增藥品
          </a>
        }
      >
        藥品、藥袋用法與仿單說明，集中保存在這裡。
      </SectionTitle>
      {fromDemo && (
        <div className="demo-context">
          <BookOpen size={18} />
          <span>
            研討會展示 ·{" "}
            {demoMedication
              ? `${demoMedication.name}已儲存。${demoMedication.confirmed ? "可開啟仿單說明。" : "目前為草稿，請先編輯並確認用法。"}`
              : "選擇藥品，開啟說明後繼續展示。"}
          </span>
          <a className="text-link" href="#demo">
            返回展示導覽
          </a>
        </div>
      )}
      {(error || message) && <Notice error>{error || message}</Notice>}
      {busy && <JobNotice text={busy} />}{" "}
      {data?.duplicates?.map((x: any) => (
        <Notice key={x.ingredient}>
          成分重複：{x.ingredient}（{x.medications.join("、")}
          ）。請向藥師確認，不要自行調整用法。
        </Notice>
      ))}
      {loading ? (
        <Busy />
      ) : data?.items.length === 0 ? (
        <section className="card">
          <Empty
            title="你的藥品清單，從這裡開始"
            action={
              <a className="btn primary" href="#add">
                <Plus size={17} />
                新增第一款藥品
              </a>
            }
          >
            新增後，可在這裡確認用法、設定提醒並對照仿單。
          </Empty>
        </section>
      ) : (
        <div className="med-grid">
          {data?.items.map((m: any, index: number) => (
            <article
              className="card med-card"
              key={m.id}
              data-medication-id={m.id}
            >
              <div className="medication-file-heading">
                <span className="medication-file-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="medication-file-label">用藥檔案</span>
                <span className={"tag " + (m.confirmed ? "green" : "amber")}>
                  {m.confirmed ? "用法已確認" : "待確認用法"}
                </span>
              </div>
              <div className="medication-file-name">
                <h2 id={`medication-${m.id}`} tabIndex={-1}>
                  {m.name}
                </h2>
                {m.id === demoMedicationId && (
                  <span className="tag">本次展示新增</span>
                )}
                <p className="muted med-license">
                  {m.licenseNo || "尚未匹配許可證"}
                </p>
              </div>
              <dl className="usage-box medication-file-usage">
                <div>
                  <dt>每次用量</dt>
                  <dd>
                    <strong>{doseLabel(m) || "待確認"}</strong>
                  </dd>
                </div>
                <div>
                  <dt>使用頻次</dt>
                  <dd>{m.frequencyRaw || "頻次待確認"}</dd>
                </div>
                <div>
                  <dt>使用途徑</dt>
                  <dd>{m.route || "待確認"}</dd>
                </div>
              </dl>
              {m.prn && <p className="medication-file-note">需要時使用</p>}
              <div className="row wrap medication-file-actions">
                <Button
                  className="secondary"
                  disabled={!m.confirmed || !!busy}
                  onClick={() => explain(m)}
                >
                  <BookOpen size={16} />
                  仿單說明
                </Button>
                <Button className="ghost" onClick={() => setEdit(m)}>
                  編輯用法
                </Button>
                {m.confirmed && !m.prn && (
                  <Button className="ghost" onClick={() => setSchedule(m)}>
                    <CalendarClock size={16} />
                    排定提醒
                  </Button>
                )}
                {m.confirmed && m.prn && (
                  <Button
                    onClick={async () => {
                      try {
                        await api("/dose-logs", "POST", {
                          medicationId: m.id,
                          dueAt: null,
                          status: "taken",
                          operationId: crypto.randomUUID(),
                        });
                        setMessage("已記錄這次服用。");
                      } catch (e: any) {
                        setMessage(e.message);
                      }
                    }}
                  >
                    記錄服用
                  </Button>
                )}
                <button
                  className="icon-button"
                  aria-label={"移除" + m.name}
                  onClick={async () => {
                    if (confirm("移除這款藥品？歷史紀錄會保留。")) {
                      try {
                        await api("/medications/" + m.id, "DELETE");
                        setResult(null);
                        refresh();
                      } catch (e: any) {
                        setMessage(e.message);
                      }
                    }
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {edit && (
        <section className="card">
          <div className="row spread">
            <h2>編輯用法</h2>
            <button
              className="icon-button"
              onClick={() => setEdit(null)}
              aria-label="關閉編輯"
            >
              <X />
            </button>
          </div>
          <Notice>修改後原提醒會停用，請依確認後的新用法重新排定。</Notice>
          <MedicationForm
            key={edit.id}
            initial={edit}
            onSave={async (m) => {
              await api("/medications/" + edit.id, "PUT", m);
              setEdit(null);
              setResult(null);
              refresh();
            }}
          />
        </section>
      )}
      {schedule && (
        <ScheduleForm
          key={schedule.id}
          medication={schedule}
          close={() => setSchedule(null)}
        />
      )}{" "}
      {result && (
        <section className="card medication-detail">
          <h2 ref={resultHeading} tabIndex={-1}>
            {data?.items
              .filter((m: Medication) => result.medicationIds.includes(m.id))
              .map((m: Medication) => m.name)
              .join("、")}
            ｜仿單白話說明
          </h2>
          {fromDemo && (
            <a
              className="btn primary"
              href={`#demo?record=${encodeURIComponent(result.id)}&step=reading`}
            >
              帶這份說明繼續展示
            </a>
          )}
          {result.result.quiz.length > 0 && (
            <a
              href={`#learning?record=${encodeURIComponent(result.id)}&section=quiz${fromDemo ? "&from=demo" : ""}`}
              className="btn primary"
            >
              繼續理解測驗
            </a>
          )}
          <Evidence
            key={result.id}
            result={result.result}
            learningId={result.id}
            initialAnswers={result.answers}
            medications={
              data?.items.filter((m: Medication) =>
                result.medicationIds.includes(m.id),
              ) || []
            }
          />
          <a
            href={`#learning?record=${encodeURIComponent(result.id)}${fromDemo ? "&from=demo" : ""}`}
            className="btn secondary"
          >
            到用藥小教室繼續學習
          </a>
        </section>
      )}
    </>
  );
}
function ScheduleForm({
  medication,
  close,
}: {
  medication: any;
  close: () => void;
}) {
  const [times, setTimes] = useState(""),
    [start, setStart] = useState(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(
        new Date(),
      ),
    ),
    [end, setEnd] = useState(""),
    [error, setError] = useState("");
  return (
    <section className="card">
      <h2>排定提醒 · {medication.name}</h2>
      <p>
        已確認頻次：{medication.frequencyRaw}。請自行確認以下時間符合藥袋用法。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/schedules", "POST", {
              medicationId: medication.id,
              times: times.split(/[,，、\s]+/).filter(Boolean),
              startDate: start,
              endDate: end || null,
            });
            close();
          } catch (e: any) {
            setError(e.message);
          }
        }}
        className="form-grid"
      >
        <Field label="每天提醒時間（24 小時制，可用逗號分隔）">
          <input
            required
            placeholder="例如：08:00, 20:00"
            value={times}
            onChange={(e) => setTimes(e.target.value)}
          />
        </Field>
        <Field label="開始日期">
          <input
            required
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="結束日期（可留白）">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
        <div className="full-grid">
          {error && <Notice error>{error}</Notice>}
          <Button type="submit" className="primary">
            確認提醒時間
          </Button>{" "}
          <Button onClick={close}>取消</Button>
        </div>
      </form>
    </section>
  );
}
export function Learning() {
  const { data, loading, error, refresh } = useData<{
      items: LearningRecord[];
    }>("/learning"),
    meds = useData<{ items: Medication[] }>("/medications");
  const [updates, setUpdates] = useState<
    Record<string, { progress: LearningProgress; answers: Record<string, number> }>
  >({});
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState("");
  const [learningHash, setLearningHash] = useState(location.hash);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const updateHash = () => setLearningHash(location.hash);
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, []);
  const params = new URLSearchParams(learningHash.split("?")[1] || "");
  const recordId = params.get("record");
  const fromDemo = params.get("from") === "demo";
  const section = ["reading", "warnings", "quiz"].includes(
    params.get("section") || "",
  )
    ? params.get("section")!
    : "reading";
  const activeRecord = data?.items.find((r) => r.id === recordId);
  const demoHref = activeRecord
    ? `#demo?record=${encodeURIComponent(activeRecord.id)}&step=reading`
    : "#demo";
  const indexHref = fromDemo ? "#learning?from=demo" : "#learning";
  const recordHref = (id: string, target = "reading") =>
    `#learning?record=${encodeURIComponent(id)}&section=${target}${fromDemo ? "&from=demo" : ""}`;
  const recordMedications = (r: LearningRecord) =>
    (meds.data?.items || []).filter((m) => r.medicationIds.includes(m.id));
  const recordProgress = (r: LearningRecord) =>
    updates[r.id]?.progress || r.progress || learningProgress(r.result.quiz, r.answers);
  const recordName = (r: LearningRecord) =>
    recordMedications(r)
      .map((m) => m.name)
      .join("、") || "藥品";
  useEffect(() => {
    if (!activeRecord || loading || meds.loading) return;
    const frame = window.requestAnimationFrame(() => {
      const target =
        document.getElementById(`${section}-${activeRecord.id}`) ||
        detailHeading.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeRecord?.id, section, loading, meds.loading]);
  return (
    <>
      <SectionTitle
        eyebrow={activeRecord ? "仿單閱讀" : "閱讀目錄"}
        title="用藥小教室"
      >
        選擇藥品閱讀仿單，接續已保存的理解題。
      </SectionTitle>
      <div className="row wrap learning-toolbar">
        {recordId ? (
          <a className="btn secondary" href={indexHref}>
            返回全部藥品
          </a>
        ) : (
          <a className="btn secondary" href="#medications">
            選擇藥品，開啟仿單說明
          </a>
        )}
        {fromDemo && (
          <a className="btn ghost" href={demoHref}>
            返回展示入口
          </a>
        )}
        <a className="btn ghost" href="#jobs">
          查看 AI 處理紀錄與重試
        </a>
      </div>
      {busy && <JobNotice text={busy} />}{" "}
      {(error || message) && <Notice error>{error || message}</Notice>}
      {meds.error && <Notice error>無法讀取藥品名稱：{meds.error}</Notice>}
      {loading || meds.loading ? (
        <Busy />
      ) : recordId && !activeRecord ? (
        <section className="card">
          <Empty
            title="找不到這份學習內容"
            action={
              <a className="btn secondary" href={indexHref}>
                返回全部藥品
              </a>
            }
          >
            內容可能已因藥品或健康資料更新而失效，請重新選擇藥品。
          </Empty>
        </section>
      ) : !data?.items.length ? (
        <section className="card">
          <Empty title="還沒有學習內容">
            在「我的藥品」開啟仿單說明，即可開始理解與練習。
          </Empty>
        </section>
      ) : activeRecord ? (
        <section
          className="card learning-record learning-detail"
          key={activeRecord.id}
          data-learning-id={activeRecord.id}
        >
          <div className="row spread">
            <h2 ref={detailHeading} tabIndex={-1}>
              {activeRecord.medicationIds.length === 2
                ? "交互作用核對"
                : recordName(activeRecord) + "｜說明與理解確認"}
            </h2>
            <span
              className={
                "tag " +
                (recordProgress(activeRecord).passed ? "green" : "amber")
              }
            >
              {learningStateLabels[recordProgress(activeRecord).status]}
            </span>
          </div>
          {activeRecord.medicationIds.length === 2 && (
            <p>{recordName(activeRecord)}</p>
          )}
          <Evidence
            result={activeRecord.result}
            learningId={activeRecord.id}
            initialAnswers={updates[activeRecord.id]?.answers || activeRecord.answers}
            medications={
              activeRecord.medicationIds.length === 1
                ? recordMedications(activeRecord)
                : undefined
            }
            onProgress={(progress, answers) =>
              setUpdates((old) => ({ ...old, [activeRecord.id]: { progress, answers } }))
            }
          />
          <div className="learning-detail-actions">
            <a className="btn secondary" href={indexHref}>
              返回全部藥品
            </a>
            {fromDemo && (
              <a className="btn ghost" href={demoHref}>
                返回展示入口
              </a>
            )}
          </div>
        </section>
      ) : (
        <div className="learning-index">
          {data.items.map((r, index) => {
            const progress = recordProgress(r);
            return (
              <article
                className="learning-index-card learning-directory-row"
                key={r.id}
                data-learning-id={r.id}
              >
                <span className="learning-directory-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="learning-directory-main">
                  <div className="learning-directory-heading">
                    <h2>{recordName(r)}</h2>
                    <span
                      className={"tag " + (progress.passed ? "green" : "amber")}
                    >
                      {learningStateLabels[progress.status]}
                    </span>
                  </div>
                  {r.medicationIds.length === 2 && (
                    <p className="muted">交互作用核對</p>
                  )}
                  <p className="learning-progress">
                    已作答 {progress.answered}／{progress.total} 題 · 已答對{" "}
                    {progress.correct} 題
                  </p>
                </div>
                <div className="row wrap learning-directory-actions">
                  <a
                    className="btn primary"
                    href={recordHref(
                      r.id,
                      progress.answered ? "quiz" : "reading",
                    )}
                  >
                    {progress.passed
                      ? "重新複習"
                      : progress.answered
                        ? "繼續學習"
                        : "開始學習"}
                    <ArrowRight size={16} />
                  </a>
                  <a className="btn ghost" href={recordHref(r.id)}>
                    閱讀仿單說明
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {!recordId && (
        <section className="card">
          <h2>兩款藥，一起核對</h2>
          <p>選擇兩款已確認的藥品，比對其仿單交互作用記載。</p>
          <div className="row wrap">
            {meds.data?.items
              .filter((m: any) => m.confirmed)
              .map((m: any) => (
                <label className="choice" key={m.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, m.id].slice(-2)
                          : selected.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.name}
                </label>
              ))}
          </div>
          <Button
            className="secondary"
            disabled={selected.length !== 2 || !!busy}
            onClick={async () => {
              setBusy("正在核對仿單…");
              try {
                const job = await submitJob(
                  "/interactions",
                  { medicationIds: selected },
                  setBusy,
                );
                await refresh();
                location.hash = recordHref(job.id).slice(1);
              } catch (e: any) {
                setMessage(e.message);
              } finally {
                setBusy("");
              }
            }}
          >
            比對交互作用
          </Button>
        </section>
      )}
    </>
  );
}
export function Chat() {
  const meds = useData<{ items: Medication[] }>("/medications"),
    history = useData("/chat");
  const [draft] = useState(chatDraftSession);
  const { question, selected, busy, error, sent, completed } =
    useSyncExternalStore(draft.subscribe, draft.read);
  const [reloadingMeds, setReloadingMeds] = useState(false);
  const selector = useRef<HTMLElement>(null),
    lastCompleted = useRef(completed);
  useEffect(() => {
    if (lastCompleted.current === completed) return;
    lastCompleted.current = completed;
    // A remounted view reads history on mount. Only the current view refreshes
    // when its background question completes, without making it a failed send.
    if (sent) void history.refresh();
  }, [completed, sent]);
  const loadingMeds = meds.loading || reloadingMeds;
  const confirmedMeds = (meds.data?.items || []).filter((m) => m.confirmed);
  const selectedIds = selected.filter((id) =>
    confirmedMeds.some((m) => m.id === id),
  );
  const canSubmit =
    !busy &&
    !loadingMeds &&
    !meds.error &&
    selectedIds.length > 0 &&
    question.trim().length > 0;
  const prerequisite = loadingMeds
    ? "正在讀取藥品，完成後即可選擇提問對象。"
    : meds.error
      ? "藥品讀取失敗，請重試後再送出；你輸入的問題會保留。"
      : !confirmedMeds.length
        ? meds.data?.items.length
          ? "目前的藥品尚未確認，請先到「我的藥品」對照藥袋確認藥品與用法，才能送出問題。"
          : "目前還沒有可提問的藥品。請先新增並確認藥品，再回來勾選提問對象。"
        : !selectedIds.length
          ? "請先在「這次想問的藥品」勾選至少一款藥品，才能送出問題。"
          : `已選擇 ${selectedIds.length} 款藥品。輸入問題後，按「送出」查閱仿單。`;
  return (
    <>
      <SectionTitle eyebrow="仿單問答" title="用藥問答">
        把看不懂的地方說出來，一起回到仿單找依據。
      </SectionTitle>
      {meds.error && <Notice error>無法讀取藥品：{meds.error}</Notice>}
      {history.error && (
        <Notice error>
          無法讀取問答紀錄：{history.error}
          <Button className="secondary" onClick={() => history.refresh()}>
            重新讀取問答紀錄
          </Button>
        </Notice>
      )}
      <div className="chat-layout">
        <section className="card chat-main">
          <div className="chat-welcome">
            <div className="circle-icon">
              <MessageCircle size={28} />
            </div>
            <h2>關於用藥，你想了解什麼？</h2>
            <p>先選擇藥品，再提出問題。回答僅依已收錄的官方仿單。</p>
          </div>
          {history.data?.items
            .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt))
            .map((c: any) => (
              <div className="chat-exchange" key={c.id}>
                <div className="question-bubble">{c.question}</div>
                <Evidence result={c.result} showQuiz={false} />
              </div>
            ))}
          {busy && <JobNotice text={busy} />}{" "}
          {error && <Notice error>{error}</Notice>}
          {sent && (
            <Notice>
              問題已處理完成，回答已儲存於問答紀錄。若紀錄未顯示，請重新讀取問答紀錄。
            </Notice>
          )}
          <a className="btn ghost" href="#jobs">
            查看 AI 處理紀錄與重試
          </a>
          <div id="chat-prerequisite">
            <Notice>{prerequisite}</Notice>
            {meds.error && (
              <Button
                className="secondary"
                disabled={loadingMeds}
                onClick={async () => {
                  setReloadingMeds(true);
                  try {
                    await meds.refresh();
                  } finally {
                    setReloadingMeds(false);
                  }
                }}
              >
                重新讀取藥品
              </Button>
            )}
            {!loadingMeds && !meds.error && !confirmedMeds.length && (
              <a
                className="btn secondary"
                href={meds.data?.items.length ? "#medications" : "#add"}
              >
                {meds.data?.items.length ? "前往確認藥品" : "新增並確認藥品"}
                <ArrowRight size={16} />
              </a>
            )}
            {!loadingMeds &&
              !meds.error &&
              confirmedMeds.length > 0 &&
              !selectedIds.length && (
                <Button
                  className="secondary"
                  onClick={() => selector.current?.focus()}
                >
                  選擇提問藥品
                  <ArrowRight size={16} />
                </Button>
              )}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!canSubmit || !draft.startSubmission()) return;
              const submittedQuestion = question.trim();
              try {
                await submitJob(
                  "/chat",
                  { question: submittedQuestion, medicationIds: selectedIds },
                  draft.progress,
                );
                draft.completeQuestion(question);
              } catch (e: any) {
                draft.fail(e.message);
              }
            }}
          >
            <div className="chat-input">
              <textarea
                required
                maxLength={500}
                aria-label="用藥問題"
                aria-describedby="chat-prerequisite chat-input-help"
                disabled={!!busy}
                value={question}
                onChange={(e) => draft.update({ question: e.target.value })}
                placeholder="例如：這款藥的仿單有哪些飲食注意事項？"
              />
              <Button className="primary" type="submit" disabled={!canSubmit}>
                <Send size={18} />
                送出
              </Button>
            </div>
            <small className="muted" id="chat-input-help">
              Enter
              為換行，完成後請按「送出」。請勿輸入姓名、身分證字號等個人識別資料。
            </small>
          </form>
        </section>
        <aside
          className="card chat-selector"
          ref={selector}
          tabIndex={-1}
          aria-labelledby="chat-medications-title"
        >
          <h3 id="chat-medications-title">這次想問的藥品</h3>
          {loadingMeds && <Busy text="正在讀取藥品…" />}
          {confirmedMeds.map((m) => (
            <label className="choice" key={m.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(m.id)}
                disabled={!!busy || !!meds.error || loadingMeds}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, m.id].slice(-8)
                    : selected.filter((id) => id !== m.id);
                  draft.update({ selected: next });
                }}
              />
              {m.name}
            </label>
          ))}
          {!loadingMeds && !meds.error && !confirmedMeds.length && (
            <p className="muted">先新增並確認藥品，才能開始問答。</p>
          )}
          <Notice>
            涉及改劑量、停藥、診斷與個人是否適用的問題，請向醫師或藥師確認。
          </Notice>
        </aside>
      </div>
    </>
  );
}
