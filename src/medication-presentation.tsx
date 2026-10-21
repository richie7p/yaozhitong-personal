import { doseLabel } from "../shared/medication";
import type { Medication } from "../shared/schema";

// Display meanings verified against the NHI medication-frequency code system:
// https://nhicore.nhi.gov.tw/pas/1.2.2/CodeSystem-medication-frequency-nhi-tw.html
// MOHW Health-05 data dictionary, pages 18–19 (2026-01-27):
// https://www.mohw.gov.tw/dl-95536-f4915b33-c4aa-476b-b5b2-135f3951a428.html
// These explanations describe source text only; they never generate a schedule.
const frequencyMeanings: Readonly<Record<string, string>> = {
  QD: "每日一次",
  BID: "每日兩次",
  TID: "每日三次",
  QID: "每日四次",
  PRN: "需要時使用",
  AC: "飯前",
  PC: "飯後",
  HS: "睡前一次",
  QDHS: "每日一次，睡前使用",
  "BID&HS": "每日兩次，且睡前再一次",
  "TID&HS": "每日三次，且睡前再一次",
};

/** Explain only a complete, recognized frequency expression, without changing it. */
export function frequencyExplanation(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const source = raw.trim();
  if (!/^[A-Za-z& \t]+$/.test(source)) return null;
  const code = source.toUpperCase();
  if (Object.hasOwn(frequencyMeanings, code)) return frequencyMeanings[code];

  // A single daily frequency may be qualified by a separate meal-time code.
  // Operators, alternatives, repeated codes and free text remain unexplained.
  const mealQualified = /^(QD|BID|TID|QID)[ \t]+(AC|PC)$/.exec(code);
  if (mealQualified)
    return `${frequencyMeanings[mealQualified[1]]}，${frequencyMeanings[mealQualified[2]]}`;
  return null;
}

/** Show the original frequency alongside its conservative, plain-language meaning. */
export function Frequency({ raw }: { raw?: string | null }) {
  const explanation = frequencyExplanation(raw);
  return (
    <span className="frequency">
      <span className="frequency-raw" style={{ whiteSpace: "pre-wrap" }}>
        {raw || "頻次待確認"}
      </span>
      {explanation && (
        <span className="frequency-explanation">（{explanation}）</span>
      )}
    </span>
  );
}

type RecordedIdentity = { id?: string; createdAt?: string };

const taipeiTimestampFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Use an explicit source offset and the Taipei zone, independent of browser settings. */
function recordedTimestamp(createdAt?: string): string | null {
  if (!createdAt) return null;
  // Stored records use a complete ISO timestamp, with optional milliseconds.
  const source =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      createdAt,
    );
  if (!source) return null;
  const [year, month, day, hour, minute, second] = source
    .slice(1, 7)
    .map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  // Date.parse may silently roll an impossible day into the next month.
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (source[7] !== "Z" && (Number(source[8]) > 23 || Number(source[9]) > 59))
  )
    return null;
  const instant = Date.parse(createdAt);
  if (!Number.isFinite(instant)) return null;
  const parts = Object.fromEntries(
    taipeiTimestampFormat
      .formatToParts(instant)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Display metadata for one stored record; never use this label as a record key. */
export function recordIdentity(record: RecordedIdentity): string {
  const timestamp = recordedTimestamp(record.createdAt);
  const parts = [
    timestamp ? `建立 ${timestamp}（臺北時間）` : "建立時間未記錄",
  ];
  if (record.id) parts.push(`編號 …${record.id.slice(-8)}`);
  return parts.join(" · ");
}

/** Distinguish individual prescriptions, including separate records with the same name. */
export function medicationIdentity(medication: Partial<Medication>): string {
  const dose = doseLabel(medication);
  const rawFrequency = medication.frequencyRaw;
  const explanation = frequencyExplanation(rawFrequency);
  const frequency = rawFrequency
    ? `${rawFrequency}${explanation ? `（${explanation}）` : ""}`
    : "頻次待確認";
  return [
    medication.strength,
    medication.form,
    dose ? `每次 ${dose}` : "用量待確認",
    medication.route || "途徑待確認",
    frequency,
    recordIdentity(medication),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function MedicationIdentity({
  medication,
}: {
  medication: Partial<Medication>;
}) {
  return (
    <span
      className="medication-identity"
      title={medication.id ? `完整編號：${medication.id}` : undefined}
    >
      {medicationIdentity(medication)}
    </span>
  );
}
