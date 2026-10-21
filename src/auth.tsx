import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  linkWithCredential,
  EmailAuthProvider,
  type Auth,
} from "firebase/auth";
import {
  getMessaging,
  getToken,
  deleteToken,
  isSupported,
} from "firebase/messaging";
import { api, setJobIdentity, setTokenProvider } from "./api";
import { requestWebPushToken, revokeWebPushToken } from "./web-push";
import { authErrorMessage } from "./auth-errors";
import { refreshEmailVerification, signInEmail } from "./email-auth";
import { readTabValue, writeTabValue } from "./session-storage";
import {
  configureFirebaseTokenProvider,
  clearFirebaseSession,
  commitFirebaseSession,
  createSessionFirebaseAuth,
  firebaseSessionNeedsReload,
  linkGoogle,
  observeFirebaseSession,
  signInGoogle,
  signInGoogleCredential,
} from "./google-auth";
interface AuthState {
  config: any;
  me: any;
  loading: boolean;
  authError: string;
  sessionRecovery: boolean;
  emailVerified: boolean;
  login: (method: string, email?: string, password?: string) => Promise<void>;
  googleCredential: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  verify: () => Promise<void>;
  link: (method: string, password?: string, email?: string) => Promise<void>;
  notify: () => Promise<void>;
}
const Context = createContext<AuthState>(null!);
let firebaseApp: FirebaseApp;
let firebaseAuth: Auth;
let deviceId = readTabValue("yzt-device-id") || "";
export function AuthProvider({ children }: { children: ReactNode }) {
  const googleTransition = useRef(false);
  const sessionEpoch = useRef(0);
  const notificationRequest = useRef<Promise<void> | null>(null);
  const notificationEpoch = useRef(0);
  const [config, setConfig] = useState<any>(null),
    [me, setMe] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [sessionRecovery, setSessionRecovery] = useState(false),
    [emailVerified, setEmailVerified] = useState(false),
    [authError, setAuthError] = useState("");
  async function reload() {
    const epoch = sessionEpoch.current;
    const user = firebaseAuth?.currentUser;
    const check = () => {
      if (
        epoch !== sessionEpoch.current ||
        (config?.mode !== "local" &&
          (!user || firebaseAuth.currentUser !== user))
      )
        throw new Error("登入狀態已變更，請重新登入。");
    };
    check();
    const next = await api("/me", "GET", undefined, undefined, check);
    check();
    // Password sign-in can restore an account that also has Google linked.
    // Commit its completed app session too, without changing either provider.
    if (config?.mode !== "local" && user) {
      await commitFirebaseSession(firebaseAuth, user);
      check();
    }
    setJobIdentity(next.account.id);
    setMe(next);
    setEmailVerified(config?.mode === "local" || !!user?.emailVerified);
    setSessionRecovery(false);
    setAuthError("");
  }
  useEffect(() => {
    let stop = () => {};
    let disposed = false;
    api("/config")
      .then(async (c) => {
        if (disposed) return;
        setConfig(c);
        if (c.mode === "local") {
          const t = readTabValue("yzt-local-token");
          if (t) {
            setTokenProvider(async () => t);
            try {
              const next = await api("/me");
              if (disposed) return;
              setJobIdentity(next.account.id);
              setMe(next);
            } catch (error) {
              if (disposed) return;
              setJobIdentity(null);
              if ((error as { status?: number }).status === 401) {
                writeTabValue("yzt-local-token", null);
                setTokenProvider(async () => "");
              } else setSessionRecovery(true);
              setAuthError(authErrorMessage(error));
            }
          }
          if (!disposed) setLoading(false);
        } else {
          if (!c.firebase?.apiKey) throw new Error("Firebase 網頁設定尚未完成");
          firebaseApp = initializeApp(c.firebase);
          firebaseAuth = createSessionFirebaseAuth(
            firebaseApp,
            Boolean(c.googleOAuthClientId),
          );
          firebaseAuth.languageCode = "zh-TW";
          stop = await observeFirebaseSession(
            firebaseAuth,
            async (u, isCurrent) => {
              if (disposed || googleTransition.current || !isCurrent()) return;
              const epoch = ++sessionEpoch.current;
              setJobIdentity(null);
              setMe(null);
              const current = () =>
                !disposed &&
                !googleTransition.current &&
                isCurrent() &&
                epoch === sessionEpoch.current &&
                firebaseAuth.currentUser === u;
              try {
                const next = u
                  ? await api("/me", "GET", undefined, undefined, () => {
                      if (!current())
                        throw new Error("登入狀態已變更，請重新登入。");
                    })
                  : null;
                if (current()) {
                  setJobIdentity(next?.account.id || null);
                  setMe(next);
                  setEmailVerified(!!u?.emailVerified);
                  setSessionRecovery(false);
                  if (u) setAuthError("");
                }
              } catch (error) {
                if (current()) {
                  setAuthError(authErrorMessage(error));
                  setSessionRecovery(!!u);
                }
              }
              if (!disposed && isCurrent()) setLoading(false);
            },
            (error) => {
              if (disposed) return;
              setMe(null);
              setLoading(false);
              setAuthError(authErrorMessage(error));
              setSessionRecovery(false);
            },
            () => !disposed,
            Boolean(c.googleOAuthClientId),
          );
          if (disposed) stop();
        }
      })
      .catch((e) => {
        if (disposed) return;
        setConfig({ error: e.message });
        setLoading(false);
      });
    return () => {
      disposed = true;
      stop();
    };
  }, []);
  async function googleCredential(idToken: string) {
    setAuthError("");
    if (firebaseSessionNeedsReload(firebaseAuth)) {
      location.reload();
      return;
    }
    const epoch = ++sessionEpoch.current;
    setJobIdentity(null);
    setMe(null);
    googleTransition.current = true;
    try {
      const next = await signInGoogleCredential(firebaseAuth, idToken);
      if (epoch !== sessionEpoch.current) return;
      setJobIdentity(next.account.id);
      setMe(next);
      setEmailVerified(!!firebaseAuth.currentUser?.emailVerified);
      setSessionRecovery(false);
    } catch (error) {
      if (epoch !== sessionEpoch.current) throw error;
      setJobIdentity(null);
      setMe(null);
      setAuthError(authErrorMessage(error));
      throw error;
    } finally {
      googleTransition.current = false;
    }
  }
  async function login(method: string, email = "", password = "") {
    setAuthError("");
    if (method === "reset" && config.mode !== "local") {
      await signInEmail(firebaseAuth, method, email, password);
      return;
    }
    const epoch = ++sessionEpoch.current;
    const check = () => {
      if (epoch !== sessionEpoch.current)
        throw new Error("登入狀態已變更，請重新登入。");
    };
    setJobIdentity(null);
    setMe(null);
    setSessionRecovery(false);
    if (config.mode === "local") {
      const { token } = await api(
        "/auth/local",
        "POST",
        { uid: method },
        undefined,
        check,
      );
      check();
      writeTabValue("yzt-local-token", token);
      setTokenProvider(async () => token);
      await reload();
      return;
    }
    if (firebaseSessionNeedsReload(firebaseAuth)) {
      location.reload();
      return;
    }
    configureFirebaseTokenProvider(firebaseAuth);
    googleTransition.current = true;
    try {
      if (method === "google") {
        try {
          await signInGoogle(firebaseAuth);
        } catch (error) {
          setJobIdentity(null);
          setTokenProvider(async () => "");
          setMe(null);
          throw error;
        }
        return;
      }
      if (firebaseAuth.currentUser) {
        await clearFirebaseSession(firebaseAuth);
        check();
        configureFirebaseTokenProvider(firebaseAuth);
      }
      const warning = await signInEmail(
        firebaseAuth,
        method,
        email,
        password,
        check,
      );
      check();
      await reload();
      check();
      if (warning) setAuthError(warning);
    } catch (error) {
      if (epoch === sessionEpoch.current && method !== "google") {
        setSessionRecovery(!!firebaseAuth.currentUser);
        if (firebaseAuth.currentUser) setAuthError(authErrorMessage(error));
      }
      throw error;
    } finally {
      if (epoch === sessionEpoch.current) googleTransition.current = false;
    }
  }
  async function logout() {
    const epoch = ++sessionEpoch.current;
    notificationEpoch.current++;
    // Honor logout immediately, before SDK callbacks or remote cleanup can wait.
    location.hash = "home";
    window.speechSynthesis?.cancel();
    const revokePush = !!deviceId || !!notificationRequest.current;
    setJobIdentity(null);
    setMe(null);
    setAuthError("");
    setSessionRecovery(false);
    const previousDevice = deviceId;
    const outgoingToken =
      previousDevice && config.mode !== "local"
        ? firebaseAuth.currentUser?.getIdToken().catch(() => "") ||
          Promise.resolve("")
        : Promise.resolve("");
    deviceId = "";
    writeTabValue("yzt-device-id", null);
    // Capture the outgoing account's token for this one cleanup request. The
    // shared provider is cleared immediately and cannot authenticate a later
    // screen or account with the outgoing identity.
    const revokingDevice = previousDevice
      ? config.mode === "local"
        ? api("/devices/" + encodeURIComponent(previousDevice), "DELETE").catch(
            () => {},
          )
        : revokeWebPushToken(async () => {
            const token = await outgoingToken;
            if (!token) return;
            await fetch(
              "/api/v1/devices/" + encodeURIComponent(previousDevice),
              {
                method: "DELETE",
                headers: { Authorization: "Bearer " + token },
                cache: "no-store",
                signal: AbortSignal.timeout(10000),
              },
            );
          })
      : Promise.resolve();
    // Start clearing authentication before push revocation or transport can
    // stall. Identity guards immediately discard any old /me completion.
    const clearing = (
      config.mode === "local"
        ? Promise.resolve(writeTabValue("yzt-local-token", null))
        : clearFirebaseSession(firebaseAuth)
    ).then(
      () => true,
      () => false,
    );
    await revokingDevice;
    if (firebaseApp && revokePush)
      await revokeWebPushToken(() => deleteToken(getMessaging(firebaseApp)));
    const cleared = await clearing;
    if (!cleared && epoch === sessionEpoch.current)
      setAuthError("登出未能完成，請重新載入登入頁確認狀態。");
    if (epoch !== sessionEpoch.current) return;
    setTokenProvider(async () => "");
    setMe(null);
    googleTransition.current = false;
  }
  async function verify() {
    try {
      if (config.mode !== "local") {
        const epoch = sessionEpoch.current;
        await refreshEmailVerification(firebaseAuth, () => {
          if (epoch !== sessionEpoch.current)
            throw new Error("登入狀態已變更，請重新操作。");
        });
        await reload();
      }
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  }
  async function link(method: string, password = "", email = "") {
    const u = firebaseAuth?.currentUser;
    if (!u) throw new Error("此功能需要 Firebase 帳號。");
    const epoch = sessionEpoch.current;
    const check = () => {
      if (epoch !== sessionEpoch.current || firebaseAuth.currentUser !== u)
        throw new Error("登入狀態已變更，請重新操作。");
    };
    try {
      if (method === "google") {
        configureFirebaseTokenProvider(firebaseAuth);
        googleTransition.current = true;
        try {
          await linkGoogle(u, firebaseAuth);
          check();
          await reload();
        } finally {
          if (epoch === sessionEpoch.current) googleTransition.current = false;
        }
      } else {
        if (password.length < 8) throw new Error("請使用至少 8 個字元的密碼。");
        const address = email.trim() || u.email;
        if (!address) throw new Error("請填寫要連結的 Email。");
        await linkWithCredential(
          u,
          EmailAuthProvider.credential(address, password),
        );
        check();
        await reload();
      }
    } catch (error) {
      throw new Error(authErrorMessage(error));
    }
  }
  async function notify() {
    if (config.mode === "local")
      throw new Error("本機模式提供站內提醒；網頁推播需要 Firebase 雲端設定。");
    if (notificationRequest.current) return notificationRequest.current;
    const user = firebaseAuth?.currentUser;
    if (!user) throw new Error("請先登入，再啟用這台裝置的推播。");
    const epoch = notificationEpoch.current;
    const assertIdentity = () => {
      if (
        notificationEpoch.current !== epoch ||
        firebaseAuth.currentUser !== user
      )
        throw new Error("登入狀態已變更，請重新啟用推播。");
    };
    const operation = (async () => {
      const token = await requestWebPushToken({
        secureContext: window.isSecureContext,
        browserSupported:
          "Notification" in window &&
          "serviceWorker" in navigator &&
          "PushManager" in window,
        vapidKey: config.vapidKey,
        permission:
          "Notification" in window ? Notification.permission : "default",
        requestPermission: () => Notification.requestPermission(),
        isSupported,
        register: () => navigator.serviceWorker.register("/sw.js"),
        getToken: (registration) =>
          getToken(getMessaging(firebaseApp), {
            vapidKey: config.vapidKey,
            serviceWorkerRegistration: registration,
          }),
        assertIdentity,
      });
      const device = await api(
        "/devices",
        "POST",
        { token },
        undefined,
        assertIdentity,
      );
      assertIdentity();
      deviceId = device.id;
      writeTabValue("yzt-device-id", deviceId);
    })();
    notificationRequest.current = operation;
    try {
      await operation;
    } finally {
      notificationRequest.current = null;
    }
  }
  return (
    <Context.Provider
      value={{
        config,
        me,
        loading,
        authError,
        sessionRecovery,
        emailVerified,
        login,
        googleCredential,
        logout,
        reload,
        verify,
        link,
        notify,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useAuth = () => useContext(Context);
