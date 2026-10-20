import {
  browserPopupRedirectResolver,
  getRedirectResult,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  linkWithPopup,
  onAuthStateChanged,
  signInWithCredential,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
  type UserCredential,
} from "firebase/auth";
import type { FirebaseApp } from "firebase/app";
import { api, setJobIdentity, setTokenProvider } from "./api";

export function createMemoryFirebaseAuth(
  app: FirebaseApp,
  credentialMode = false,
) {
  // Redirect processing starts during Auth initialization. Select memory here,
  // before the SDK can restore or persist the returning user.
  return initializeAuth(app, {
    persistence: inMemoryPersistence,
    ...(credentialMode
      ? {}
      : { popupRedirectResolver: browserPopupRedirectResolver }),
  });
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
  await api("/auth/google-profile", "POST", { googleIdToken });
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
  return signInWithRedirect(auth, googleProvider());
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
  setJobIdentity(null);
  setTokenProvider(async () => "");
  // signOut can queue behind the same unfinished SDK initialization. Never
  // block the error screen on it or let a later result restore this session.
  void Promise.resolve()
    .then(() => signOut(auth))
    .then(() => {
      if ((error as { code?: string } | null)?.code !== "google_return_timeout")
        reloadRequired.delete(auth);
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
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        const error = returnTimeout();
        invalidateReturn(auth, attempt, error);
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
          invalidateReturn(auth, attempt, error);
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
    if (credentialMode) return null;
    const result = await getRedirectResult(auth);
    check();
    return result ? await completeProfile(result, check) : null;
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
  configureFirebaseTokenProvider(auth);
  const completion = withinDeadline(auth, attempt, async (check) => {
    check();
    if (!googleIdToken)
      throw new Error("Google 未提供完整登入憑證，請重新登入。");
    const result = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(googleIdToken),
    );
    check();
    await completeProfile(result, check, googleIdToken);
    const next = await api("/me");
    check();
    return next;
  }).finally(() => {
    credentialTransitions.delete(auth);
    credentialAttempts.delete(auth);
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
  let initialSession = true;
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
    const first = initialSession;
    initialSession = false;
    void Promise.resolve(onUser(user, isCurrent)).then(() => {
      if (first && isCurrent()) clearTimeout(timer);
    }, failed);
  });
  return () => {
    clearTimeout(timer);
    stop();
  };
}

export async function linkGoogle(user: User) {
  return completeProfile(
    await linkWithPopup(user, googleProvider(), browserPopupRedirectResolver),
  );
}
