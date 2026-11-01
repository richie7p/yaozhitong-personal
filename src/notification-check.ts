export interface NotificationAttempt {
  source: "push" | "test";
  state: "accepted" | "failed";
  attemptedAt: string;
  notificationPresent?: boolean;
  errorCode?: string;
}

export function isNotificationAttempt(
  value: unknown,
): value is NotificationAttempt {
  if (!value || typeof value !== "object") return false;
  const v = value as NotificationAttempt;
  return (
    (v.source === "push" || v.source === "test") &&
    (v.state === "accepted" || v.state === "failed") &&
    typeof v.attemptedAt === "string" &&
    Number.isFinite(Date.parse(v.attemptedAt)) &&
    (v.notificationPresent === undefined ||
      typeof v.notificationPresent === "boolean") &&
    (v.errorCode === undefined ||
      [
        "NotAllowedError",
        "InvalidStateError",
        "SecurityError",
        "UnknownError",
      ].includes(v.errorCode))
  );
}

export async function notificationDeviceStatus() {
  const supported =
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator;
  if (!supported)
    return {
      supported: false,
      permission: "default" as NotificationPermission,
      ready: false,
      subscribed: false,
    };
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager?.getSubscription();
  return {
    supported: true,
    permission: Notification.permission,
    ready: registration?.active?.state === "activated",
    subscribed: Boolean(subscription),
  };
}

/** This exercises the actual worker display path, without creating a medication
 * reminder or claiming that a remote push or an OS banner was received. */
export async function testNotificationDisplay(): Promise<NotificationAttempt> {
  if (!("Notification" in window) || !("serviceWorker" in navigator))
    throw new Error("此瀏覽器不支援通知顯示測試。");
  if (Notification.permission !== "granted")
    throw new Error("請先啟用網頁推播，並允許這個網站顯示通知。");
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration?.active)
    throw new Error("背景通知尚未就緒，請重新整理頁面後重試。");
  const worker = registration.active;
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error("背景通知沒有回應，請重新整理頁面後重試。"));
    }, 8000);
    channel.port1.onmessage = (event) => {
      if (
        event.data?.requestId !== requestId ||
        !isNotificationAttempt(event.data?.attempt)
      )
        return;
      close();
      resolve(event.data.attempt);
    };
    try {
      worker.postMessage({ type: "yzt-test-notification", requestId }, [
        channel.port2,
      ]);
    } catch {
      close();
      reject(new Error("背景通知無法啟動，請重新整理頁面後重試。"));
    }
  });
}

export function notificationFailureText(code?: string) {
  if (code === "NotAllowedError" || code === "SecurityError")
    return "瀏覽器沒有允許顯示通知，請檢查此網站的通知權限。";
  if (code === "InvalidStateError")
    return "背景通知尚未就緒，請重新整理頁面後重試。";
  return "瀏覽器無法建立通知，請重新整理頁面後重試。";
}
