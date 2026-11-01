import { useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, Monitor } from "lucide-react";
import { Button, Notice } from "./components";
import {
  isNotificationAttempt,
  notificationDeviceStatus,
  notificationFailureText,
  testNotificationDisplay,
  type NotificationAttempt,
} from "./notification-check";

export function NotificationSettings({
  enable,
  accountName,
}: {
  enable: () => Promise<unknown>;
  accountName: string;
}) {
  const [device, setDevice] = useState<Awaited<
    ReturnType<typeof notificationDeviceStatus>
  > | null>(null);
  const [busy, setBusy] = useState<"enable" | "test" | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState<NotificationAttempt | null>(null);
  const [observed, setObserved] = useState<boolean | null>(null);
  const mounted = useRef(true);
  async function refresh() {
    try {
      const value = await notificationDeviceStatus();
      if (mounted.current) setDevice(value);
    } catch {
      if (mounted.current) setDevice(null);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const receive = (event: MessageEvent) => {
      if (
        event.data?.type !== "yzt-notification-display" ||
        !isNotificationAttempt(event.data?.attempt)
      )
        return;
      const worker = event.source as ServiceWorker | null;
      if (
        !worker?.scriptURL ||
        new URL(worker.scriptURL).href !==
          new URL("/sw.js", location.origin).href
      )
        return;
      setAttempt(event.data.attempt);
      setObserved(null);
    };
    navigator.serviceWorker?.addEventListener("message", receive);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      navigator.serviceWorker?.removeEventListener("message", receive);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  async function run(kind: "enable" | "test") {
    if (busy) return;
    setBusy(kind);
    setMessage("");
    setFailed(false);
    if (kind === "test") {
      setAttempt(null);
      setObserved(null);
    }
    try {
      if (kind === "enable") {
        await enable();
        if (mounted.current)
          setMessage("已啟用這台裝置的推播。請再測試通知顯示。");
      } else {
        const result = await testNotificationDisplay();
        if (mounted.current) setAttempt(result);
      }
    } catch (error) {
      if (mounted.current) {
        setFailed(true);
        setMessage(
          error instanceof Error
            ? error.message
            : "通知設定未完成，請稍後重試。",
        );
      }
    } finally {
      if (mounted.current) {
        setBusy(null);
        void refresh();
      }
    }
  }
  return (
    <section
      className="card notification-settings"
      aria-labelledby="device-notification-heading"
    >
      <div className="notification-settings-heading">
        <span className="notification-settings-icon">
          <Bell size={22} aria-hidden="true" />
        </span>
        <div>
          <h2 id="device-notification-heading">這台裝置的通知</h2>
          <p>目前帳號：{accountName}</p>
        </div>
      </div>
      <p>先啟用推播，再確認提醒能出現在螢幕或通知中心。</p>
      <dl className="notification-device-status">
        <div>
          <dt>網站通知權限</dt>
          <dd>
            {!device
              ? "尚未取得狀態"
              : !device.supported
                ? "此瀏覽器不支援"
                : device.permission === "granted"
                  ? "已允許"
                  : device.permission === "denied"
                    ? "已封鎖"
                    : "尚未允許"}
          </dd>
        </div>
        <div>
          <dt>背景通知</dt>
          <dd>{device?.ready ? "已就緒" : "尚未就緒"}</dd>
        </div>
        <div>
          <dt>瀏覽器推播訂閱</dt>
          <dd>{device?.subscribed ? "已有訂閱" : "尚未訂閱"}</dd>
        </div>
      </dl>
      <div className="stack">
        <Button
          className="secondary"
          disabled={Boolean(busy)}
          onClick={() => void run("enable")}
        >
          <Bell size={17} />
          {busy === "enable" ? "正在啟用推播…" : "啟用網頁推播"}
        </Button>
        <Button disabled={Boolean(busy)} onClick={() => void run("test")}>
          <Monitor size={17} />
          {busy === "test" ? "正在測試通知…" : "測試通知顯示"}
        </Button>
      </div>
      <p className="fine">
        測試通知不會新增用藥提醒；它只檢查這台裝置的顯示功能，不代表遠端推播已送達。
      </p>
      {busy === "enable" && (
        <p role="status" className="fine">
          請查看瀏覽器的通知權限提示並選擇允許，正在連線推播服務。
        </p>
      )}
      {message && <Notice error={failed}>{message}</Notice>}
      {attempt && (
        <div className="notification-attempt" role="status">
          <strong>
            {attempt.source === "push"
              ? "這個瀏覽器收到一則推播"
              : "裝置通知測試"}
          </strong>
          <p className="fine">
            {new Date(attempt.attemptedAt).toLocaleString("zh-TW")}
          </p>
          {attempt.state === "failed" ? (
            <p>{notificationFailureText(attempt.errorCode)}</p>
          ) : (
            <>
              <p>瀏覽器已接受通知顯示要求，請查看螢幕或通知中心。</p>
              {attempt.notificationPresent === true && (
                <p className="fine">瀏覽器的通知清單中已有這則通知。</p>
              )}
              {attempt.notificationPresent === false && (
                <p className="fine">
                  瀏覽器的通知清單中未找到這則通知，尚不能確認顯示成功。
                </p>
              )}
              {observed === null ? (
                <div className="row">
                  <Button onClick={() => setObserved(true)}>我看到了</Button>
                  <Button onClick={() => setObserved(false)}>沒有看到</Button>
                </div>
              ) : observed ? (
                <p>
                  <CheckCircle2 size={17} aria-hidden="true" /> 你已確認看到
                  {attempt.source === "push" ? "推播" : "測試"}通知。
                </p>
              ) : (
                <p>
                  尚未確認送達。請檢查系統是否允許 Chrome
                  顯示通知橫幅與通知中心通知，以及是否啟用勿擾模式。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
