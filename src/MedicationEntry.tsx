import { CalendarClock, Search } from "lucide-react";
import { AddMedication } from "./MedicationViews";
import { QuickMedication } from "./QuickMedication";
import "./QuickMedication.css";

export function MedicationEntry({
  mode,
  recognitionId,
}: {
  mode: "quick" | "chronic";
  recognitionId?: string | null;
}) {
  return (
    <>
      <nav className="medication-entry-modes" aria-label="藥品照片用途">
        <a
          href="#add?mode=quick"
          aria-current={mode === "quick" ? "page" : undefined}
        >
          <Search size={23} aria-hidden="true" />
          <span>
            <strong>一般藥品快速查詢</strong>
            <small>感冒藥、藥膏等，查詢基礎資訊，不需建檔</small>
          </span>
        </a>
        <a
          href="#add?mode=chronic"
          aria-current={mode === "chronic" ? "page" : undefined}
        >
          <CalendarClock size={23} aria-hidden="true" />
          <span>
            <strong>慢性處方箋／長期用藥</strong>
            <small>核對並保存藥品，依個人用法建立日常提醒</small>
          </span>
        </a>
      </nav>
      {mode === "quick" ? (
        <QuickMedication recognitionId={recognitionId} />
      ) : (
        <>
          <p className="medication-entry-context">
            長期用藥建檔：保存後可整理提醒與用藥紀錄。個人用法仍可稍後確認。
          </p>
          <AddMedication recognitionId={recognitionId} />
        </>
      )}
    </>
  );
}
