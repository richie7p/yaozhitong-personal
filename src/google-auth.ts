import {
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getRedirectResult,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  linkWithPopup,
  onAuthStateChanged,
  signInWithCredential,
  signInWithRedirect,
  signOut,
  setPersistence,
  type Auth,
  type User,
  type UserCredential,
} from "firebase/auth";
import type { FirebaseApp } from "firebase/app";
import { api, setJobIdentity, setTokenProvider } from "./api";

export function createSessionFirebaseAuth(
  app: FirebaseApp,
  credentialMode = false,
) {
  // Firebase owns only its authentication record. Questions and health drafts
  // stay in memory. The SDK tries sessionStorage first and falls back to memory.
  return initializeAuth(app, {
    persistence: [browserSessionPersistence, inMemoryPersistence],
    ...(credentialMode
      ? {}
      : { popupRedirectResolver: browserPopupRedirectResolver }),
  });
}

// Kept for callers of the original initialization helper.
export const createMemoryFirebaseAuth = createSessionFirebaseAuth;

function sessionKey(auth: Auth) {
  return `yzt-google-session:${auth.app?.name || auth.name}:${auth.app?.options.apiKey || ""}`;
}

function readSession(auth: Auth): { status: string; uid?: string } | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(auth));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(
  auth: Auth,
  state: { status: string; uid?: string } | null,
) {
  try {
    if (state) sessionStorage.setItem(sessionKey(auth), JSON.stringify(state));
    else sessionStorage.removeItem(sessionKey(auth));
    return true;
  } catch {
    return false;
  }
}

async function beginGoogleSession(auth: Auth) {
  // Persist the quarantine before Firebase can persist a credential. A refresh
  // during profile verification must never expose that unfinished session.
  if (!writeSession(auth, { status: "pending" }))
    await setPersistence(auth, inMemoryPersistence);
  setJobIdentity(null);
}

export async function commitFirebaseSession(auth: Auth, user: User) {
  if (!writeSession(auth, { status: "ready", uid: user.uid }))
    await setPersistence(auth, inMemoryPersistence);
}

export async function clearFirebaseSession(auth: Auth) {
  const attempt = activeCredentialAttempts.get(auth);
  if (attempt) {
    invalidateReturn(
      auth,
      attempt,
      Object.assign(new Error("登入狀態已變更，請重新登入。"), {
        code: "identity_changed",
      }),
    );
  }
  setJobIdentity(null);
  setTokenProvider(async () => "");
  // An in-flight SDK credential can still arrive after signOut. Keep its
  // quarantine until the late operation has been rejected and signed out again.
  writeSession(auth, { status: "pending" });
  await signOut(auth);
  if (!attempt) writeSession(auth, null);
}

export function configureFirebaseTokenProvider(auth: Auth) {
  setTokenProvider(async () => {
    const user = auth.currentUser;
    if (reloadRequired.has(auth) || !user) return "";
    const token = await user.getIdToken();
    return !reloadRequired.has(auth) && auth.currentUser === user ? token : "";
  });
}

function googleProvider() {
  const provider = new GoogleAuthProvider();
  // The SDK requests profile by default. Email must be explicit when Firebase
  // allows separate accounts for different providers using the same address.
  // This scope does not replace the backend's verified-email check.
  provider.addScope("email");
  return provider;
}

async function completeProfile(
  result: UserCredential,
  assertCurrent: () => void = () => {},
  suppliedGoogleIdToken?: string,
) {
  assertCurrent();
  const googleIdToken =
    suppliedGoogleIdToken ||
    GoogleAuthProvider.credentialFromResult(result)?.idToken;
  if (!googleIdToken)
    throw new Error("Google 未提供完整登入憑證，請重新登入。");
  await api(
    "/auth/google-profile",
    "POST",
    { googleIdToken },
    undefined,
    assertCurrent,
  );
  assertCurrent();
  await result.user.reload();
  assertCurrent();
  await result.user.getIdToken(true);
  assertCurrent();
  return result;
}

export async function signInGoogle(auth: Auth) {
  configureFirebaseTokenProvider(auth);
  // A successful call navigates away; completion belongs to the returning page.
  await beginGoogleSession(auth);
  try {
    return await signInWithRedirect(auth, googleProvider());
  } catch (error) {
    await clearFirebaseSession(auth);
    throw error;
  }
}

const RETURN_TIMEOUT_MS = 30_000;
interface SessionAttempt {
  deadline: number;
  failed: boolean;
  error?: unknown;
}
interface RedirectAttempt extends SessionAttempt {
  completion: Promise<UserCredential | null>;
}
const redirectAttempts = new WeakMap<Auth, RedirectAttempt>();
const reloadRequired = new WeakSet<Auth>();
const credentialTransitions = new WeakSet<Auth>();
const credentialAttempts = new WeakMap<Auth, Promise<any>>();
const activeCredentialAttempts = new WeakMap<Auth, SessionAttempt>();

export function firebaseSessionNeedsReload(auth: Auth) {
  return reloadRequired.has(auth);
}

function returnTimeout() {
  return Object.assign(new Error("Google 登入逾時，請重新整理頁面後再試。"), {
    code: "google_return_timeout",
  });
}

function invalidateReturn(auth: Auth, attempt: SessionAttempt, error: unknown) {
  if (attempt.failed) return;
  attempt.failed = true;
  attempt.error = error;
  reloadRequired.add(auth);
  writeSession(auth, { status: "pending" });
  setJobIdentity(null);
  setTokenProvider(async () => "");
  // signOut can queue behind the same unfinished SDK initialization. Never
  // block the error screen on it or let a later result restore this session.
  void Promise.resolve()
    .then(() => signOut(auth))
    .then(() => {
      if (
        !["google_return_timeout", "identity_changed"].includes(
          (error as { code?: string } | null)?.code || "",
        )
      ) {
        reloadRequired.delete(auth);
        writeSession(auth, null);
      }
    })
    .catch(() => {});
}

function assertCurrent(attempt: SessionAttempt) {
  if (attempt.failed) throw attempt.error;
  if (Date.now() >= attempt.deadline) throw returnTimeout();
}

function withinDeadline<T>(
  auth: Auth,
  attempt: SessionAttempt,
  work: (check: () => void) => Promise<T>,
  ownsSession: () => boolean = () => true,
) {
  const fail = (error: unknown) => {
    if (ownsSession()) invalidateReturn(auth, attempt, error);
    else {
      attempt.failed = true;
      attempt.error = error;
    }
  };
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        const error = returnTimeout();
        fail(error);
        reject(error);
      },
      Math.max(0, attempt.deadline - Date.now()),
    );
    void Promise.resolve()
      .then(() => work(() => assertCurrent(attempt)))
      .then(
        (result) => {
          clearTimeout(timer);
          if (!attempt.failed) resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          if (attempt.failed && ownsSession()) {
            // signInWithCredential itself cannot be aborted; clear a user that
            // the SDK persisted after the original timeout/logout cleanup.
            void signOut(auth).catch(() => {});
          } else if (!attempt.failed) fail(error);
          reject(attempt.error);
        },
      );
  });
}

export function finishGoogleRedirect(auth: Auth, credentialMode = false) {
  const existing = redirectAttempts.get(auth);
  if (existing) return existing.completion;
  const attempt: RedirectAttempt = {
    deadline: Date.now() + RETURN_TIMEOUT_MS,
    failed: false,
    completion: null!,
  };
  redirectAttempts.set(auth, attempt);
  configureFirebaseTokenProvider(auth);
  attempt.completion = withinDeadline(auth, attempt, async (check) => {
    // GIS exchanges its credential directly with Firebase. This mode never
    // initializes the iframe resolver or consumes a legacy redirect result.
    const result = credentialMode ? null : await getRedirectResult(auth);
    check();
    if (result) {
      await beginGoogleSession(auth);
      check();
      const current = () => {
        check();
        if (auth.currentUser !== result.user)
          throw new Error("登入狀態已變更，請重新登入。");
      };
      await completeProfile(result, current);
      await api("/me", "GET", undefined, undefined, current);
      current();
      await commitFirebaseSession(auth, result.user);
      current();
      return result;
    }
    // Wait for session restoration before inspecting the persisted identity.
    await auth.authStateReady?.();
    check();
    const saved = readSession(auth);
    const user = auth.currentUser;
    const google = user?.providerData?.some(
      (p) => p.providerId === "google.com",
    );
    if (
      saved?.status === "pending" ||
      (google && (saved?.status !== "ready" || saved.uid !== user?.uid))
    )
      throw new Error(
        "上次 Google 登入未完成，請重新登入。電子信箱登入仍可使用。",
      );
    return null;
  });
  return attempt.completion;
}

export function signInGoogleCredential(auth: Auth, googleIdToken: string) {
  const existing = credentialAttempts.get(auth);
  if (existing) return existing;
  if (firebaseSessionNeedsReload(auth)) return Promise.reject(returnTimeout());
  const attempt: SessionAttempt = {
    deadline: Date.now() + RETURN_TIMEOUT_MS,
    failed: false,
  };
  credentialTransitions.add(auth);
  activeCredentialAttempts.set(auth, attempt);
  configureFirebaseTokenProvider(auth);
  const completion = withinDeadline(auth, attempt, async (check) => {
    check();
    if (!googleIdToken)
      throw new Error("Google 未提供完整登入憑證，請重新登入。");
    await beginGoogleSession(auth);
    check();
    const result = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(googleIdToken),
    );
    check();
    const current = () => {
      check();
      if (auth.currentUser !== result.user)
        throw Object.assign(new Error("登入狀態已變更，請重新登入。"), {
          code: "identity_changed",
        });
    };
    await completeProfile(result, current, googleIdToken);
    const next = await api("/me", "GET", undefined, undefined, current);
    current();
    await commitFirebaseSession(auth, result.user);
    current();
    return next;
  }).finally(() => {
    credentialTransitions.delete(auth);
    credentialAttempts.delete(auth);
    activeCredentialAttempts.delete(auth);
  });
  credentialAttempts.set(auth, completion);
  return completion;
}

export async function observeFirebaseSession(
  auth: Auth,
  onUser: (user: User | null, isCurrent: () => boolean) => void | Promise<void>,
  onRedirectError: (error: unknown) => void,
  isActive: () => boolean,
  credentialMode = false,
) {
  try {
    await finishGoogleRedirect(auth, credentialMode);
  } catch (error) {
    if (!isActive()) return () => {};
    onRedirectError(error);
    void Promise.resolve(onUser(null, isActive)).catch(() => {});
    return () => {};
  }
  if (!isActive()) return () => {};
  const attempt = redirectAttempts.get(auth)!;
  let stop = () => {};
  let eventVersion = 0;
  const isCurrent = () =>
    isActive() &&
    !attempt.failed &&
    !reloadRequired.has(auth) &&
    !credentialTransitions.has(auth);
  const failed = (error: unknown) => {
    if (attempt.failed) return;
    clearTimeout(timer);
    invalidateReturn(auth, attempt, error);
    stop();
    if (!isActive()) return;
    onRedirectError(error);
    void Promise.resolve(onUser(null, isActive)).catch(() => {});
  };
  // The first /me read shares the return deadline. Later auth events are not
  // constrained by an old login timer.
  const timer = setTimeout(
    () => failed(returnTimeout()),
    Math.max(0, attempt.deadline - Date.now()),
  );
  stop = onAuthStateChanged(auth, (user) => {
    if (!isCurrent()) return;
    const version = ++eventVersion;
    const eventIsCurrent = () => isCurrent() && version === eventVersion;
    void Promise.resolve(onUser(user, eventIsCurrent)).then(() => {
      if (eventIsCurrent()) {
        clearTimeout(timer);
      }
    }, failed);
  });
  return () => {
    clearTimeout(timer);
    stop();
  };
}

export async function linkGoogle(user: User, auth?: Auth) {
  const previous = auth ? readSession(auth) : null;
  if (auth) await beginGoogleSession(auth);
  let result: UserCredential;
  try {
    result = await linkWithPopup(
      user,
      googleProvider(),
      browserPopupRedirectResolver,
    );
  } catch (error) {
    if (auth && auth.currentUser === user) writeSession(auth, previous);
    throw error;
  }
  if (!auth) return completeProfile(result);
  const attempt: SessionAttempt = {
    deadline: Date.now() + RETURN_TIMEOUT_MS,
    failed: false,
  };
  return withinDeadline(
    auth,
    attempt,
    async (check) => {
      const current = () => {
        check();
        if (auth.currentUser !== user)
          throw Object.assign(new Error("登入狀態已變更，請重新登入。"), {
            code: "identity_changed",
          });
      };
      await completeProfile(result, current);
      await api("/me", "GET", undefined, undefined, current);
      current();
      await commitFirebaseSession(auth, user);
      current();
      return result;
    },
    () => auth.currentUser === user,
  );
}
