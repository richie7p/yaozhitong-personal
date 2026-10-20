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
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  linkWithCredential,
  EmailAuthProvider,
  signOut,
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
import {
  configureFirebaseTokenProvider,
  createMemoryFirebaseAuth,
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
let deviceId = sessionStorage.getItem("yzt-device-id") || "";
export function AuthProvider({ children }: { children: ReactNode }) {
  const googleTransition = useRef(false);
  const notificationRequest = useRef<Promise<void> | null>(null);
  const notificationEpoch = useRef(0);
  const [config, setConfig] = useState<any>(null),
    [me, setMe] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [authError, setAuthError] = useState("");
  async function reload() {
    const next = await api("/me");
    setJobIdentity(next.account.id);
    setMe(next);
  }
  useEffect(() => {
    let stop = () => {};
    let disposed = false;
    api("/config")
      .then(async (c) => {
        if (disposed) return;
        setConfig(c);
        if (c.mode === "local") {
          const t = sessionStorage.getItem("yzt-local-token");
          if (t) {
            setTokenProvider(async () => t);
            try {
              const next = await api("/me");
              if (disposed) return;
              setJobIdentity(next.account.id);
              setMe(next);
            } catch {
              if (disposed) return;
              sessionStorage.removeItem("yzt-local-token");
              setJobIdentity(null);
              setTokenProvider(async () => "");
            }
          }
          if (!disposed) setLoading(false);
        } else {
          if (!c.firebase?.apiKey) throw new Error("Firebase 網頁設定尚未完成");
          firebaseApp = initializeApp(c.firebase);
          firebaseAuth = createMemoryFirebaseAuth(
            firebaseApp,
            Boolean(c.googleOAuthClientId),
          );
          firebaseAuth.languageCode = "zh-TW";
          stop = await observeFirebaseSession(
            firebaseAuth,
            async (u, isCurrent) => {
              if (disposed || googleTransition.current || !isCurrent()) return;
              setJobIdentity(u?.uid || null);
              try {
                const next = u ? await api("/me") : null;
                if (!disposed && !googleTransition.current && isCurrent())
                  setMe(next);
              } catch {
                if (!disposed && !googleTransition.current && isCurrent())
                  setMe(null);
              }
              if (!disposed && isCurrent()) setLoading(false);
            },
            (error) => {
              if (disposed) return;
              setMe(null);
              setLoading(false);
              setAuthError(
                error instanceof Error &&
                  !String((error as { code?: string }).code || "").startsWith(
                    "auth/",
                  )
                  ? error.message
                  : "Google 登入未完成，請再試一次或使用電子信箱登入。",
              );
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
    googleTransition.current = true;
    try {
      const next = await signInGoogleCredential(firebaseAuth, idToken);
      setJobIdentity(next.account.id);
      setMe(next);
    } catch (error) {
      setJobIdentity(null);
      setMe(null);
      setAuthError(
        error instanceof Error &&
          !String((error as { code?: string }).code || "").startsWith("auth/")
          ? error.message
          : "Google 登入未完成，請再試一次或使用電子信箱登入。",
      );
      throw error;
    } finally {
      googleTransition.current = false;
    }
  }
  async function login(method: string, email = "", password = "") {
    setAuthError("");
    if (config.mode === "local") {
      const { token } = await api("/auth/local", "POST", { uid: method });
      sessionStorage.setItem("yzt-local-token", token);
      setTokenProvider(async () => token);
      await reload();
      return;
    }
    if (firebaseSessionNeedsReload(firebaseAuth)) {
      location.reload();
      return;
    }
    configureFirebaseTokenProvider(firebaseAuth);
    if (method === "google") {
      googleTransition.current = true;
      try {
        await signInGoogle(firebaseAuth);
      } catch (error) {
        void signOut(firebaseAuth).catch(() => {});
        setJobIdentity(null);
        setTokenProvider(async () => "");
        setMe(null);
        throw error;
      } finally {
        googleTransition.current = false;
      }
      return;
    } else if (method === "register") {
      const result = await createUserWithEmailAndPassword(
        firebaseAuth,
        email,
        password,
      );
      await sendEmailVerification(result.user);
    } else if (method === "reset") {
      await sendPasswordResetEmail(firebaseAuth, email);
      return;
    } else await signInWithEmailAndPassword(firebaseAuth, email, password);
    await reload();
  }
  async function logout() {
    notificationEpoch.current++;
    const revokePush = !!deviceId || !!notificationRequest.current;
    setJobIdentity(null);
    if (deviceId) {
      await api("/devices/" + deviceId, "DELETE").catch(() => {});
      deviceId = "";
      sessionStorage.removeItem("yzt-device-id");
    }
    if (firebaseApp && revokePush)
      await revokeWebPushToken(() => deleteToken(getMessaging(firebaseApp)));
    if (config.mode === "local") sessionStorage.removeItem("yzt-local-token");
    else await signOut(firebaseAuth);
    setTokenProvider(async () => "");
    setMe(null);
    location.hash = "home";
    speechSynthesis.cancel();
  }
  async function verify() {
    if (firebaseAuth?.currentUser) {
      await firebaseAuth.currentUser.reload();
      await firebaseAuth.currentUser.getIdToken(true);
      if (!firebaseAuth.currentUser.emailVerified)
        await sendEmailVerification(firebaseAuth.currentUser);
      await reload();
    }
  }
  async function link(method: string, password = "", email = "") {
    const u = firebaseAuth?.currentUser;
    if (!u) throw new Error("此功能需要 Firebase 帳號。");
    if (method === "google") {
      configureFirebaseTokenProvider(firebaseAuth);
      googleTransition.current = true;
      try {
        await linkGoogle(u);
        await reload();
      } finally {
        googleTransition.current = false;
      }
    } else {
      if (password.length < 8) throw new Error("請使用至少 8 個字元的密碼。");
      const address = email.trim() || u.email;
      if (!address) throw new Error("請填寫要連結的 Email。");
      await linkWithCredential(
        u,
        EmailAuthProvider.credential(address, password),
      );
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
      const device = await api("/devices", "POST", { token }, undefined, assertIdentity);
      assertIdentity();
      deviceId = device.id;
      sessionStorage.setItem("yzt-device-id", deviceId);
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
