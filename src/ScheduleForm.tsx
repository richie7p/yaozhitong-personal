import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { Button, Field, Notice } from "./components";
import { Frequency, MedicationIdentity } from "./medication-presentation";
import { parseReminderTimes } from "./reminder-times";

export function ScheduleForm({
  medication,
  close,
}: {
  medication: any;
  close: () => void;
}) {
  const [times, setTimes] = useState("");
  const [start, setStart] = useState(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(
      new Date(),
    ),
  );
  const [end, setEnd] = useState("");
  const [error, setError] = useState("");
  const [timeError, setTimeError] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const timeInput = useRef<HTMLInputElement>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const endInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const helpId = `${id}-times-help`;
  const errorId = `${id}-error`;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }, [medication.id]);

  return (
    <section className="card schedule-form">
      <h2 ref={heading} tabIndex={-1}>
        排定提醒 · {medication.name}
      </h2>
      <MedicationIdentity medication={medication} />
      <p>
        已確認頻次：
        <Frequency raw={medication.frequencyRaw} />
      </p>
      <p>請依藥袋用法自行確認提醒時間；時間不會由頻次自動填入。</p>
      <form
        noValidate
        aria-busy={busy}
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          setError("");
          setTimeError(false);
          const parsed = parseReminderTimes(times);
          if (parsed.error) {
            setError(parsed.error);
            setTimeError(true);
            timeInput.current?.focus();
            return;
          }
          if (!start) {
            setError("請選擇提醒的開始日期。");
            startInput.current?.focus();
            return;
          }
          if (end && end < start) {
            setError("結束日期不能早於開始日期，請重新選擇。");
            endInput.current?.focus();
            return;
          }
          submitting.current = true;
          setBusy(true);
          try {
            await api("/schedules", "POST", {
              medicationId: medication.id,
              times: parsed.times,
              startDate: start,
              endDate: end || null,
            });
            // Saving can finish after navigation. Invalidate the current agenda
            // without carrying medication data or a previous account's response.
            window.dispatchEvent(new Event("yzt-schedules-changed"));
            close();
          } catch (e: unknown) {
            setError(
              e instanceof Error && e.message
                ? e.message
                : "提醒時間儲存失敗，請稍後再試。",
            );
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
        className="form-grid"
      >
        <div className="full-grid reminder-times-field">
          <Field label="每天提醒時間（24 小時制，可用逗號分隔）">
            <input
              ref={timeInput}
              required
              disabled={busy}
              aria-describedby={helpId + (timeError ? ` ${errorId}` : "")}
              aria-invalid={timeError || undefined}
              placeholder="例如：08:00, 20:00"
              value={times}
              onChange={(e) => {
                setTimes(e.target.value);
                if (timeError) {
                  setTimeError(false);
                  setError("");
                }
              }}
            />
          </Field>
          <p className="muted" id={helpId}>
            早上 8 點填 08:00；晚上 8 點填 20:00。
            多個時間可用逗號、頓號或空白隔開，例如：08:00, 20:00。每天最多 8
            個時間。
          </p>
        </div>
        <Field label="開始日期">
          <input
            ref={startInput}
            required
            disabled={busy}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="結束日期（可留白）">
          <input
            ref={endInput}
            disabled={busy}
            type="date"
            min={start || undefined}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
        <div className="full-grid">
          {error && (
            <div id={errorId}>
              <Notice error>{error}</Notice>
            </div>
          )}
          <Button type="submit" className="primary" disabled={busy}>
            {busy ? "儲存提醒中…" : "確認提醒時間"}
          </Button>{" "}
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
        </div>
      </form>
    </section>
  );
}
