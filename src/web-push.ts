interface PushDependencies {
  secureContext: boolean;
  browserSupported: boolean;
  vapidKey: string;
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  isSupported: () => Promise<boolean>;
  register: () => Promise<ServiceWorkerRegistration>;
  getToken: (
    registration: ServiceWorkerRegistration,
    assertActive: () => void,
  ) => Promise<string>;
  assertIdentity?: () => void;
}

const unsupported =
  "此瀏覽器不支援網頁推播。iPhone／iPad 請先將網站加入主畫面，再從主畫面開啟；站內提醒仍可使用。";

export async function pushDeviceId(token: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

/** The origin-wide lock must follow the real transport, rather than the
 * ordinary API's shorter UI timeout. Callers keep their own bounded UI wait. */
export async function registerPushDevice(
  token: string,
  authorization: string,
  assertActive: () => void,
) {
  assertActive();
  let response: Response;
  try {
    response = await fetch("/api/v1/devices", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
  } catch {
    assertActive();
    throw new Error("推播裝置登錄未完成，請確認網路後再啟用。");
  }
  assertActive();
  let device: any;
  try {
    device = await response.json();
  } catch {
    throw new Error("推播裝置登錄未完成，請稍後再啟用。");
  }
  assertActive();
  if (!response.ok)
    throw new Error(device?.message || "推播裝置登錄未完成，請稍後再啟用。");
  if (
    typeof device?.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(device.id)
  )
    throw new Error("推播裝置登錄未完成，請稍後再啟用。");
  return { id: device.id as string };
}

/** Bound browser/FCM setup; a late result must never register an app device. */
export async function requestWebPushToken(
  dependencies: PushDependencies,
): Promise<string> {
  if (!dependencies.secureContext || !dependencies.browserSupported)
    throw new Error(unsupported);
  if (!dependencies.vapidKey)
    throw new Error("網站尚未完成推播設定，站內提醒仍可使用。");
  if (dependencies.permission === "denied")
    throw new Error(
      "通知已被瀏覽器封鎖，請在此網站的權限設定允許通知後重試；站內提醒仍可使用。",
    );
  let expired = false;
  let stage = "等待通知授權";
  let timer: ReturnType<typeof setTimeout>;
  const assertActive = () => {
    dependencies.assertIdentity?.();
    if (expired) throw new Error("推播設定已逾時，請重新啟用。");
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(
        new Error(
          `${stage}逾時。請確認瀏覽器的通知提示與網路後重試；站內提醒仍可使用。`,
        ),
      );
    }, 30000);
  });
  const operation = (async () => {
    assertActive();
    // Call before any async feature detection so iOS retains the user's gesture.
    const permission =
      dependencies.permission === "granted"
        ? "granted"
        : await dependencies.requestPermission();
    assertActive();
    if (permission !== "granted")
      throw new Error("未授權推播，站內提醒仍可使用。");
    stage = "檢查推播支援";
    const supported = await dependencies.isSupported();
    assertActive();
    if (!supported) throw new Error(unsupported);
    stage = "準備背景通知";
    const registration = await dependencies.register();
    assertActive();
    stage = "連線推播服務";
    const token = await dependencies.getToken(registration, assertActive);
    assertActive();
    if (!token)
      throw new Error("未取得推播裝置憑證，請稍後重新啟用；站內提醒仍可使用。");
    return token;
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Logout must also recover if the push provider cannot finish revocation. */
export async function revokeWebPushToken(
  revoke: () => Promise<unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(revoke)
        .then(
          () => true,
          () => false,
        ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
