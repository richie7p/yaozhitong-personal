import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  linkWithPopup,
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
import { api, setTokenProvider } from "./api";
interface AuthState {
  config: any;
  me: any;
  loading: boolean;
  login: (method: string, email?: string, password?: string) => Promise<void>;
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
  const [config, setConfig] = useState<any>(null),
    [me, setMe] = useState<any>(null),
    [loading, setLoading] = useState(true);
  async function reload() {
    setMe(await api("/me"));
  }
  useEffect(() => {
    let stop = () => {};
    api("/config")
      .then(async (c) => {
        setConfig(c);
        if (c.mode === "local") {
          const t = sessionStorage.getItem("yzt-local-token");
          if (t) {
            setTokenProvider(async () => t);
            try {
              await reload();
            } catch {
              sessionStorage.removeItem("yzt-local-token");
            }
          }
          setLoading(false);
        } else {
          if (!c.firebase?.apiKey) throw new Error("Firebase 網頁設定尚未完成");
          firebaseApp = initializeApp(c.firebase);
          firebaseAuth = getAuth(firebaseApp);
          firebaseAuth.languageCode = "zh-TW";
          await setPersistence(firebaseAuth, inMemoryPersistence);
          setTokenProvider(async () =>
            firebaseAuth.currentUser
              ? firebaseAuth.currentUser.getIdToken()
              : "",
          );
          stop = onAuthStateChanged(firebaseAuth, async (u) => {
            try {
              setMe(u ? await api("/me") : null);
            } catch {
              setMe(null);
            }
            setLoading(false);
          });
        }
      })
      .catch((e) => {
        setConfig({ error: e.message });
        setLoading(false);
      });
    return () => stop();
  }, []);
  async function login(method: string, email = "", password = "") {
    if (config.mode === "local") {
      const { token } = await api("/auth/local", "POST", { uid: method });
      sessionStorage.setItem("yzt-local-token", token);
      setTokenProvider(async () => token);
      await reload();
      return;
    }
    if (method === "google")
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
    else if (method === "register") {
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
    if (method === "google") await linkWithPopup(u, new GoogleAuthProvider());
    else {
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
        login,
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
