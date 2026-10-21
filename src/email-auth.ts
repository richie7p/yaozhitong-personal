import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { authErrorMessage } from "./auth-errors";

function emailActionSettings(page: "profile" | "home") {
  if (typeof window === "undefined") return undefined;
  try {
    const origin = new URL(window.location.origin);
    if (!["https:", "http:"].includes(origin.protocol)) return undefined;
    // Use only this site's origin and a fixed route. Never forward query state,
    // addresses or an arbitrary return URL from the current page into email.
    return { url: origin.origin + "/#" + page, handleCodeInApp: false };
  } catch {
    return undefined;
  }
}

async function sendVerification(user: User) {
  const settings = emailActionSettings("profile");
  if (settings) await sendEmailVerification(user, settings);
  else await sendEmailVerification(user);
}

export async function signInEmail(
  auth: Auth,
  method: string,
  email: string,
  password: string,
  assertCurrent: () => void = () => {},
) {
  const address = email.trim();
  if (method === "reset") {
    try {
      const settings = emailActionSettings("home");
      if (settings) await sendPasswordResetEmail(auth, address, settings);
      else await sendPasswordResetEmail(auth, address);
    } catch (error) {
      // Keep the same confirmation for addresses with no password account.
      if ((error as { code?: string }).code !== "auth/user-not-found")
        throw error;
    }
    return "";
  }
  if (method === "register" && password.length < 8)
    throw Object.assign(new Error("請使用至少 8 個字元的密碼。"), {
      code: "auth/weak-password",
    });
  const result =
    method === "register"
      ? await createUserWithEmailAndPassword(auth, address, password)
      : await signInWithEmailAndPassword(auth, address, password);
  try {
    assertCurrent();
  } catch (error) {
    // A logout can finish while the SDK's sign-in request is still pending.
    // Do not let that late response persist a new authenticated session.
    if (auth.currentUser === result.user) await signOut(auth);
    throw error;
  }
  if (method !== "register") return "";
  let warning = "";
  try {
    await sendVerification(result.user);
  } catch (error) {
    warning =
      "帳號已建立，但驗證信尚未寄出。" +
      authErrorMessage(error) +
      "可到帳號與設定重新寄送。";
  }
  assertCurrent();
  return warning;
}

export async function refreshEmailVerification(
  auth: Auth,
  assertCurrent: () => void,
) {
  const user = auth.currentUser;
  if (!user) throw new Error("請先登入，再更新信箱驗證狀態。");
  const check = () => {
    assertCurrent();
    if (auth.currentUser !== user)
      throw new Error("登入狀態已變更，請重新操作。");
  };
  await user.reload();
  check();
  await user.getIdToken(true);
  check();
  if (!user.emailVerified) await sendVerification(user);
  check();
}
