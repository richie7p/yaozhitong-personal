import { useState } from "react";
import {
  Plus,
  Search,
  ScanLine,
  Pill,
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
import {
  Button,
  Busy,
  Empty,
  Evidence,
  Field,
  Notice,
  SectionTitle,
  useData,
} from "./components";
import type { GroundedResult } from "../shared/schema";
const blank = {
  name: "",
  licenseNo: null as string | null,
  strength: "",
  form: "",
  doseAmount: null as number | null,
  doseUnit: "",
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
        "frequencyRaw",
        "route",
      ])
        value[key] ??= "";
      return value;
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
            set("doseAmount", e.target.value ? Number(e.target.value) : null)
          }
          placeholder="待確認"
        />
      </Field>
      <Field label="劑量單位">
        <input
          value={m.doseUnit}
          onChange={(e) => set("doseUnit", e.target.value)}
          placeholder="例如：錠、包、毫升"
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
        需要時才服用（不排定時提醒）
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
        <Button type="submit" className="primary" disabled={busy}>
          <Save size={17} />
          {busy ? "儲存中…" : m.confirmed ? "確認並儲存藥品" : "儲存草稿"}
        </Button>
      </div>
    </form>
  );
}
export function AddMedication() {
  const [tab, setTab] = useState("photo"),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [draft, setDraft] = useState<any>(null),
    [recognized, setRecognized] = useState<any[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [file, setFile] = useState<File | null>(null);
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
    try {
      const j = await submitJob(
        "/recognitions",
        { image: await fileBase64(file), mediaType: file.type },
        setBusy,
      );
      setRecognized(j.result.medications);
      if (j.result.guidance || j.result.status === "failed")
        setError(j.result.guidance || "無法辨識，請重新拍攝。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
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
      <SectionTitle eyebrow="ADD MEDICATION" title="新增一份用藥資訊">
        拍照或搜尋藥名，確認之後再加入你的藥品清單。
      </SectionTitle>
      <div className="tabs">
        {[
          ["photo", "拍攝藥袋"],
          ["search", "搜尋藥名"],
          ["manual", "手動建檔"],
        ].map(([id, t]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              setDraft(null);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {error && <Notice error>{error}</Notice>}
      {busy && <Busy text={busy} />}
      {tab === "photo" && (
        <section className="card">
          <div className="upload-area">
            <ScanLine size={44} />
            <h2>讓藥袋的字，清楚留在照片裡</h2>
            <p>
              平放、光線均勻，避開反光。請先遮住姓名、身分證號等不需要辨識的資訊。
            </p>
            <label className="btn secondary">
              選擇或拍攝照片
              <input
                className="visually-hidden"
                type="file"
                accept="image/jpeg,image/png"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            {file && <span>{file.name}</span>}
            <Button
              className="primary"
              disabled={!file || !!busy}
              onClick={scan}
            >
              開始辨識 <ArrowRight size={17} />
            </Button>
            <small>限 JPEG／PNG，8 MB 以內；圖片完成辨識後刪除。</small>
          </div>
          {recognized.map((m, i) => (
            <div className="card small" key={i}>
              <div className="row spread">
                <h3>{m.name}</h3>
                <span className="tag amber">請逐項確認</span>
              </div>
              <p>{m.rawText}</p>
              <Button
                onClick={() => setDraft({ ...blank, ...m, licenseNo: null })}
              >
                編輯這筆資料
              </Button>
              {m.candidates?.map((c: any) => (
                <button
                  className="search-result"
                  key={c.licenseNo}
                  onClick={() =>
                    setDraft({
                      ...blank,
                      ...m,
                      name: c.nameZh,
                      licenseNo: c.licenseNo,
                      strength: c.strength,
                      form: c.form,
                    })
                  }
                >
                  <div>
                    <strong>{c.nameZh}</strong>
                    <small>{c.licenseNo}</small>
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
      {tab === "search" && (
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
        <section className="card">
          <h2>核對藥品與用法</h2>
          <Notice>
            沒有辨識到的欄位保持空白。請依藥袋或向藥師確認，切勿自行推測。
          </Notice>
          <MedicationForm
            key={JSON.stringify(draft)}
            initial={draft || blank}
            onSave={async (m) => {
              await api("/medications", "POST", m);
              location.hash = "medications";
            }}
          />
        </section>
      )}
    </>
  );
}
export function Medications() {
  const { data, error, loading, refresh } = useData("/medications");
  const [edit, setEdit] = useState<any>(null),
    [schedule, setSchedule] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(""),
    [result, setResult] = useState<any>(null);
  async function explain(m: any) {
    setBusy("正在整理官方仿單…");
    setMessage("");
    try {
      const j = await submitJob("/bundles", { medicationIds: [m.id] }, setBusy);
      setResult(j);
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <SectionTitle
        eyebrow="MY MEDICATIONS"
        title="我的藥品"
        action={
          <a className="btn primary" href="#add">
            <Plus size={18} />
            新增藥品
          </a>
        }
      >
        把每一款藥的用法確認清楚，再放心記錄日常。
      </SectionTitle>
      {(error || message) && <Notice error>{error || message}</Notice>}
      {busy && <Busy text={busy} />}{" "}
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
          {data?.items.map((m: any) => (
            <article className="card med-card" key={m.id}>
              <div className="row spread">
                <div className="pill-icon">
                  <Pill size={23} />
                </div>
                <span className={"tag " + (m.confirmed ? "green" : "amber")}>
                  {m.confirmed ? "用法已確認" : "待確認用法"}
                </span>
              </div>
              <h2>{m.name}</h2>
              <p className="muted med-license">
                {m.licenseNo || "尚未匹配許可證"}
              </p>
              <div className="usage-box">
                <strong>
                  {m.doseAmount ?? "待確認"} {m.doseUnit}
                </strong>
                <span>{m.frequencyRaw || "頻次待確認"}</span>
                {m.prn && <span>需要時服用</span>}
              </div>
              <div className="row wrap">
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
                      await api("/medications/" + m.id, "DELETE");
                      refresh();
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
            initial={edit}
            onSave={async (m) => {
              await api("/medications/" + edit.id, "PUT", m);
              setEdit(null);
              refresh();
            }}
          />
        </section>
      )}
      {schedule && (
        <ScheduleForm medication={schedule} close={() => setSchedule(null)} />
      )}{" "}
      {result && (
        <section className="card">
          <h2>仿單白話說明</h2>
          <Evidence result={result.result} learningId={result.id} />
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
  const { data, loading, error, refresh } = useData("/learning"),
    meds = useData("/medications");
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState("");
  return (
    <>
      <SectionTitle eyebrow="LEARN WITH CONFIDENCE" title="用藥小教室">
        對照原文、理解警語，用幾個小問題確認自己看懂了。
      </SectionTitle>
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
              await submitJob(
                "/interactions",
                { medicationIds: selected },
                setBusy,
              );
              refresh();
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
      {busy && <Busy text={busy} />}{" "}
      {(error || message) && <Notice error>{error || message}</Notice>}
      {loading ? (
        <Busy />
      ) : !data?.items.length ? (
        <section className="card">
          <Empty title="還沒有學習內容">
            在「我的藥品」開啟仿單說明，即可開始理解與練習。
          </Empty>
        </section>
      ) : (
        data.items.map((r: any) => (
          <section className="card" key={r.id}>
            <div className="row spread">
              <h2>
                {r.medicationIds.length === 2
                  ? "交互作用核對"
                  : "藥品說明與測驗"}
              </h2>
              {r.passed && <span className="tag green">已完成測驗</span>}
            </div>
            <Evidence result={r.result} learningId={r.id} />
          </section>
        ))
      )}
    </>
  );
}
export function Chat() {
  const meds = useData("/medications"),
    history = useData("/chat");
  const [question, setQuestion] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  return (
    <>
      <SectionTitle eyebrow="ASK WITH SOURCES" title="用藥問答">
        把看不懂的地方說出來，一起回到仿單找依據。
      </SectionTitle>
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
                <Evidence result={c.result} />
              </div>
            ))}
          {busy && <Busy text={busy} />}{" "}
          {error && <Notice error>{error}</Notice>}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setBusy("正在查閱仿單…");
              try {
                await submitJob(
                  "/chat",
                  { question, medicationIds: selected },
                  setBusy,
                );
                setQuestion("");
                history.refresh();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy("");
              }
            }}
          >
            <div className="chat-input">
              <textarea
                required
                maxLength={500}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如：這款藥的仿單有哪些飲食注意事項？"
              />
              <Button
                className="primary"
                type="submit"
                disabled={!!busy || !selected.length}
              >
                <Send size={18} />
                送出
              </Button>
            </div>
            <small className="muted">
              請勿輸入姓名、身分證字號等個人識別資料。
            </small>
          </form>
        </section>
        <aside className="card chat-selector">
          <h3>這次想問的藥品</h3>
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
                        ? [...selected, m.id].slice(-8)
                        : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                {m.name}
              </label>
            ))}
          {!meds.data?.items.some((m: any) => m.confirmed) && (
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
