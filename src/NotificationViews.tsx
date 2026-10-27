import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";
import { useAuth } from "./auth";
import { Button, Busy, Empty, Notice, SectionTitle } from "./components";
import "./notifications.css";

interface NotificationRecord {
  id: string;
  message: string;
  status: string;
  createdAt?: string;
  dueAt?: string;
  sentAt?: string;
  recipientId?: string;
}

const statuses: Record<string, string> = {
  pending: "待傳送",
  sent: "推送已處理",
  cancelled: "已取消",
};
const taipeiTime = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function recordedTime(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value}>{taipeiTime.format(new Date(value))}</time>
  ) : (
    "時間未記錄"
  );
}

export function Notifications() {
  const { me } = useAuth();
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<{ items: NotificationRecord[] }>("/notifications")
      .then(({ items }) => {
        if (active) setItems(items);
      })
      .catch((error: unknown) => {
        if (active)
          setError(
            error instanceof Error ? error.message : "暫時無法讀取通知紀錄。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [version]);

  const records = [...(items || [])].sort(
    (a, b) =>
      (Date.parse(b.createdAt || "") || 0) -
        (Date.parse(a.createdAt || "") || 0) || b.id.localeCompare(a.id),
  );

  return (
    <>
      <SectionTitle
        eyebrow="日常提醒"
        title="通知紀錄"
        action={
          <Button
            className="secondary"
            disabled={loading}
            onClick={() => setVersion((value) => value + 1)}
          >
            <RefreshCw size={17} />
            {loading ? "正在載入…" : error ? "重新載入" : "重新整理"}
          </Button>
        }
      >
        查看目前帳號的提醒與處理狀態。
      </SectionTitle>
      <section className="card notification-intro" aria-label="通知紀錄說明">
        <div className="row spread wrap">
          <strong>
            目前帳號：{me?.account.displayName || me?.account.email}
          </strong>
          <a className="text-link" href="#profile">
            前往通知設定
          </a>
        </div>
        <p>
          「推送已處理」表示系統已完成推播處理，無法確認手機是否顯示或是否已閱讀。
        </p>
        <small>
          依建立時間由新到舊排列，時間為台北時間。新通知可按「重新整理」查看。
        </small>
      </section>
      {error && (
        <Notice error>
          {error}
          {!!items?.length &&
            " 下方保留上次載入的紀錄，請重新載入取得最新狀態。"}
        </Notice>
      )}
      {loading ? (
        <Busy text="正在讀取通知紀錄…" />
      ) : records.length ? (
        <ol className="notification-list" aria-label="提醒紀錄">
          {records.map((record) => (
            <li key={record.id}>
              <article className="card notification-item">
                <div className="row spread wrap">
                  <h2>
                    {record.recipientId ? "家人用藥提醒" : "我的用藥提醒"}
                  </h2>
                  <span
                    className={
                      "tag" + (record.status === "pending" ? " amber" : "")
                    }
                  >
                    {statuses[record.status] || "狀態待確認"}
                  </span>
                </div>
                <p className="notification-message">
                  {record.message || "請開啟藥智通查看提醒。"}
                </p>
                <dl className="notification-meta">
                  <div>
                    <dt>建立時間</dt>
                    <dd>{recordedTime(record.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>提醒時段</dt>
                    <dd>{recordedTime(record.dueAt)}</dd>
                  </div>
                  {record.status === "sent" && record.sentAt && (
                    <div>
                      <dt>處理時間</dt>
                      <dd>{recordedTime(record.sentAt)}</dd>
                    </div>
                  )}
                </dl>
              </article>
            </li>
          ))}
        </ol>
      ) : !error ? (
        <section className="card">
          <Empty
            title="目前沒有通知紀錄"
            action={
              <a className="btn secondary" href="#medications">
                查看我的藥品
              </a>
            }
          >
            排定提醒後，系統產生的提醒會保留在這裡。也可以到通知設定啟用這台裝置的推播。
          </Empty>
        </section>
      ) : null}
    </>
  );
}
