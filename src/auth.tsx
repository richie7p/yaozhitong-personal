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
    setJobIdentity(null);
    if (deviceId) {
      await api("/devices/" + deviceId, "DELETE").catch(() => {});
      if (firebaseApp)
        await deleteToken(getMessaging(firebaseApp)).catch(() => {});
      deviceId = "";
      sessionStorage.removeItem("yzt-device-id");
    }
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
    if (!(await isSupported()))
      throw new Error("此瀏覽器不支援網頁推播，站內提醒仍可使用。");
    if ((await Notification.requestPermission()) !== "granted")
      throw new Error("未授權推播，站內提醒仍可使用。");
    const registration = await navigator.serviceWorker.register("/sw.js");
    const token = await getToken(getMessaging(firebaseApp), {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: registration,
    });
    deviceId = (await api("/devices", "POST", { token })).id;
    sessionStorage.setItem("yzt-device-id", deviceId);
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
