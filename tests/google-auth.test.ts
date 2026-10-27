import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  signInWithEmailAndPassword,
  signInWithRedirect,
  signOut,
  setPersistence,
  type Auth,
  type User,
  type UserCredential,
} from "firebase/auth";
import type { FirebaseApp } from "firebase/app";
import {
  configureFirebaseTokenProvider,
  clearFirebaseSession,
  createMemoryFirebaseAuth,
  firebaseSessionNeedsReload,
  finishGoogleRedirect,
  linkGoogle,
  observeFirebaseSession,
  signInGoogle,
  signInGoogleCredential,
} from "../src/google-auth";
import { api, setTokenProvider } from "../src/api";

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/auth")>()),
  initializeAuth: vi.fn(),
  getRedirectResult: vi.fn(),
  signInWithRedirect: vi.fn(),
  signInWithCredential: vi.fn(),
  linkWithPopup: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signOut: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  setPersistence: vi.fn(),
}));

let user: User;
let auth: Auth;
const fetchMock = vi.fn();
const unsubscribe = vi.fn();
let storage: Map<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.mocked(setPersistence).mockResolvedValue(undefined);
  user = {
    uid: "synthetic-user",
    reload: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue("synthetic-firebase-token"),
  } as unknown as User;
  auth = { name: "synthetic-auth", currentUser: user } as Auth;
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () => Response.json({ updated: true }));
  vi.spyOn(GoogleAuthProvider, "credentialFromResult").mockReturnValue(
    GoogleAuthProvider.credential("synthetic-google-id-token"),
  );
  vi.mocked(getRedirectResult).mockResolvedValue(null);
  vi.mocked(signInWithRedirect).mockResolvedValue(undefined as never);
  vi.mocked(signInWithCredential).mockResolvedValue({ user } as UserCredential);
  vi.mocked(onAuthStateChanged).mockReturnValue(unsubscribe);
  vi.mocked(signOut).mockImplementation(async (target) => {
    Object.assign(target, { currentUser: null });
  });
  configureFirebaseTokenProvider(auth);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setTokenProvider(async () => "");
});
function redirectResult() {
  const result = { user } as UserCredential;
  vi.mocked(getRedirectResult).mockResolvedValueOnce(result);
  return result;
}
function observer() {
  const callback = vi.mocked(onAuthStateChanged).mock.calls.at(-1)?.[1];
  if (typeof callback !== "function") throw new Error("Missing observer.");
  return callback;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Google redirect sign-in and explicit popup linking", () => {
  it("chooses tab session persistence with a memory fallback before initialization", () => {
    const app = { name: "synthetic-app" } as FirebaseApp;
    vi.mocked(initializeAuth).mockReturnValueOnce(auth);
    expect(createMemoryFirebaseAuth(app)).toBe(auth);
    expect(initializeAuth).toHaveBeenCalledWith(app, {
      persistence: [browserSessionPersistence, inMemoryPersistence],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  });

  it("starts same-page redirect with email scope and waits for the return page", async () => {
    await signInGoogle(auth);
    expect(signInWithRedirect).toHaveBeenCalledTimes(1);
    const [target, provider] = vi.mocked(signInWithRedirect).mock.calls[0];
    expect(target).toBe(auth);
    expect(provider).toBeInstanceOf(GoogleAuthProvider);
    expect((provider as GoogleAuthProvider).getScopes().sort()).toEqual([
      "email",
      "profile",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getRedirectResult).not.toHaveBeenCalled();
    expect(linkWithPopup).not.toHaveBeenCalled();
  });

  it("keeps explicit account linking as a popup on the supplied Firebase user", async () => {
    const result = { user } as UserCredential;
    vi.mocked(linkWithPopup).mockResolvedValueOnce(result);
    expect(await linkGoogle(user)).toBe(result);
    const [target, provider] = vi.mocked(linkWithPopup).mock.calls[0];
    expect(target).toBe(user);
    expect(vi.mocked(linkWithPopup).mock.calls[0][2]).toBe(
      browserPopupRedirectResolver,
    );
    expect((provider as GoogleAuthProvider).getScopes().sort()).toEqual([
      "email",
      "profile",
    ]);
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(getRedirectResult).not.toHaveBeenCalled();
  });

  it("returns null normally on a page without a redirect result", async () => {
    await expect(finishGoogleRedirect(auth)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(signInWithRedirect).not.toHaveBeenCalled();
  });

  it("restores the Firebase bearer after logout before completing the return", async () => {
    const result = redirectResult();
    setTokenProvider(async () => "");
    await expect(finishGoogleRedirect(auth)).resolves.toBe(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/google-profile",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer synthetic-firebase-token",
        }),
        body: JSON.stringify({ googleIdToken: "synthetic-google-id-token" }),
      }),
    );
    expect(user.reload).toHaveBeenCalledTimes(1);
    expect(user.getIdToken).toHaveBeenCalledWith(true);
  });

  it("does not promote the client provider email into a verified Firebase identity", async () => {
    Object.assign(user, {
      email: null,
      emailVerified: false,
      providerData: [
        { providerId: "google.com", email: "synthetic@example.invalid" },
      ],
    });
    redirectResult();
    const returned = await finishGoogleRedirect(auth);
    expect(returned?.user.email).toBeNull();
    expect(returned?.user.emailVerified).toBe(false);
  });

  it("shares result consumption and profile completion across repeated initialization", async () => {
    redirectResult();
    const first = finishGoogleRedirect(auth);
    const second = finishGoogleRedirect(auth);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await finishGoogleRedirect(auth);
    expect(getRedirectResult).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(user.reload).toHaveBeenCalledTimes(1);
  });

  it("propagates canceled redirect initiation without using another login method", async () => {
    const cancellation = { code: "auth/redirect-cancelled-by-user" };
    vi.mocked(signInWithRedirect).mockRejectedValueOnce(cancellation);
    await expect(signInGoogle(auth)).rejects.toBe(cancellation);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(linkWithPopup).not.toHaveBeenCalled();
    expect(signInWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it("does not replace a missing Google credential with the Firebase token", async () => {
    redirectResult();
    vi.mocked(GoogleAuthProvider.credentialFromResult).mockReturnValueOnce(
      null,
    );
    await expect(finishGoogleRedirect(auth)).rejects.toThrow("完整登入憑證");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith(auth);
  });

  it("preserves an explicit link conflict without switching accounts", async () => {
    const conflict = { code: "auth/credential-already-in-use" };
    vi.mocked(linkWithPopup).mockRejectedValueOnce(conflict);
    await expect(linkGoogle(user)).rejects.toBe(conflict);
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("Bounded Google return and session initialization", () => {
  it("leaves loading after 30 seconds even when both SDK initialization and sign-out hang", async () => {
    vi.mocked(getRedirectResult).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(signOut).mockReturnValueOnce(new Promise(() => {}));
    const onUser = vi.fn();
    const onError = vi.fn();
    const starting = observeFirebaseSession(auth, onUser, onError, () => true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "google_return_timeout" }),
    );
    expect(onUser).toHaveBeenCalledWith(null, expect.any(Function));
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(firebaseSessionNeedsReload(auth)).toBe(true);
    configureFirebaseTokenProvider(auth);
    await api("/config");
    expect(
      fetchMock.mock.calls.at(-1)?.[1].headers.Authorization,
    ).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not bootstrap or expose a redirect result that arrives after the deadline", async () => {
    const late = deferred<UserCredential | null>();
    vi.mocked(getRedirectResult).mockReturnValueOnce(late.promise);
    const onError = vi.fn();
    const onUser = vi.fn();
    const starting = observeFirebaseSession(auth, onUser, onError, () => true);
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    Object.assign(auth, { currentUser: user });
    late.resolve({ user } as UserCredential);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(user.reload).not.toHaveBeenCalled();
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(onUser).toHaveBeenCalledExactlyOnceWith(null, expect.any(Function));
    expect(firebaseSessionNeedsReload(auth)).toBe(true);
  });

  it("does not wait for sign-out to display a normal redirect failure", async () => {
    vi.mocked(getRedirectResult).mockRejectedValueOnce(
      new Error("Failed return"),
    );
    vi.mocked(signOut).mockReturnValueOnce(new Promise(() => {}));
    const onError = vi.fn();
    await observeFirebaseSession(auth, vi.fn(), onError, () => true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(firebaseSessionNeedsReload(auth)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the remaining profile steps if verification finishes after timeout", async () => {
    redirectResult();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const onError = vi.fn();
    const starting = observeFirebaseSession(auth, vi.fn(), onError, () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    response.resolve(Response.json({ updated: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(user.reload).not.toHaveBeenCalled();
    expect(user.getIdToken).not.toHaveBeenCalledWith(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAuthStateChanged).not.toHaveBeenCalled();
  });

  it("times out a user reload without starting a late forced token refresh", async () => {
    redirectResult();
    const reload = deferred<void>();
    vi.mocked(user.reload).mockReturnValueOnce(reload.promise);
    const onError = vi.fn();
    const starting = observeFirebaseSession(auth, vi.fn(), onError, () => true);
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    reload.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(user.getIdToken).not.toHaveBeenCalledWith(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAuthStateChanged).not.toHaveBeenCalled();
  });

  it("times out a forced token refresh without exposing the user", async () => {
    redirectResult();
    vi.mocked(user.getIdToken).mockImplementation((force) =>
      force
        ? new Promise(() => {})
        : Promise.resolve("synthetic-firebase-token"),
    );
    const onUser = vi.fn();
    const onError = vi.fn();
    const starting = observeFirebaseSession(auth, onUser, onError, () => true);
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onUser).toHaveBeenCalledExactlyOnceWith(null, expect.any(Function));
    expect(onAuthStateChanged).not.toHaveBeenCalled();
  });

  it("shares the 30-second deadline with the first session read and ignores its late result", async () => {
    const result = deferred<UserCredential | null>();
    vi.mocked(getRedirectResult).mockReturnValueOnce(result.promise);
    const session = deferred<void>();
    let visible: User | null = null;
    const onError = vi.fn();
    const onUser = vi.fn(async (u: User | null, isCurrent: () => boolean) => {
      if (u) await session.promise;
      if (isCurrent()) visible = u;
    });
    const starting = observeFirebaseSession(auth, onUser, onError, () => true);
    await vi.advanceTimersByTimeAsync(25_000);
    result.resolve({ user } as UserCredential);
    await starting;
    observer()(user);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(visible).toBeNull();
    session.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(visible).toBeNull();
  });

  it("clears the deadline once the first session callback completes", async () => {
    const onError = vi.fn();
    const stop = await observeFirebaseSession(
      auth,
      vi.fn(),
      onError,
      () => true,
    );
    observer()(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });
});

describe("GIS credential login without the Firebase iframe resolver", () => {
  it("initializes tab persistence without the resolver and does not consume redirect state", async () => {
    const app = { name: "synthetic-app" } as FirebaseApp;
    vi.mocked(initializeAuth).mockReturnValueOnce(auth);
    createMemoryFirebaseAuth(app, true);
    expect(initializeAuth).toHaveBeenCalledWith(app, {
      persistence: [browserSessionPersistence, inMemoryPersistence],
    });
    const onUser = vi.fn();
    await observeFirebaseSession(auth, onUser, vi.fn(), () => true, true);
    observer()(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(getRedirectResult).not.toHaveBeenCalled();
    expect(onUser).toHaveBeenCalledWith(null, expect.any(Function));
  });

  it("exchanges the credential and verifies the original Google token before returning /me", async () => {
    const me = { account: { id: "synthetic-user" } };
    fetchMock
      .mockResolvedValueOnce(Response.json({ updated: true }))
      .mockResolvedValueOnce(Response.json(me));
    setTokenProvider(async () => "");
    const result = await signInGoogleCredential(auth, "synthetic-gis-id-token");
    expect(result).toEqual(me);
    const [target, credential] = vi.mocked(signInWithCredential).mock.calls[0];
    expect(target).toBe(auth);
    expect(credential).toEqual(
      GoogleAuthProvider.credential("synthetic-gis-id-token"),
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/google-profile");
    expect(fetchMock.mock.calls[0][1].body).toBe(
      JSON.stringify({ googleIdToken: "synthetic-gis-id-token" }),
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer synthetic-firebase-token",
    );
    expect(user.reload).toHaveBeenCalledTimes(1);
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(
      vi.mocked(user.getIdToken).mock.invocationCallOrder.at(-2),
    ).toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/me");
    expect(GoogleAuthProvider.credentialFromResult).not.toHaveBeenCalled();
    expect(getRedirectResult).not.toHaveBeenCalled();
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(linkWithPopup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses early observer identity while profile verification is pending", async () => {
    const onUser = vi.fn();
    await observeFirebaseSession(auth, onUser, vi.fn(), () => true, true);
    observer()(null);
    await vi.advanceTimersByTimeAsync(0);
    onUser.mockClear();
    const profile = deferred<Response>();
    fetchMock.mockReturnValueOnce(profile.promise);
    const login = signInGoogleCredential(auth, "synthetic-gis-id-token");
    await vi.advanceTimersByTimeAsync(0);
    observer()(user);
    expect(onUser).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    profile.resolve(Response.json({ updated: true }));
    await login;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose a late credential result after timeout even if sign-out already finished", async () => {
    const onUser = vi.fn();
    await observeFirebaseSession(auth, onUser, vi.fn(), () => true, true);
    observer()(null);
    await vi.advanceTimersByTimeAsync(0);
    onUser.mockClear();
    const credential = deferred<UserCredential>();
    vi.mocked(signInWithCredential).mockReturnValueOnce(credential.promise);
    const login = signInGoogleCredential(auth, "synthetic-gis-id-token");
    const rejected = expect(login).rejects.toMatchObject({
      code: "google_return_timeout",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(signOut).toHaveBeenCalledTimes(1);
    Object.assign(auth, { currentUser: user });
    credential.resolve({ user } as UserCredential);
    observer()(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(user.reload).not.toHaveBeenCalled();
    expect(onUser).not.toHaveBeenCalled();
    expect(firebaseSessionNeedsReload(auth)).toBe(true);
    configureFirebaseTokenProvider(auth);
    await api("/config");
    expect(
      fetchMock.mock.calls.at(-1)?.[1].headers.Authorization,
    ).toBeUndefined();
  });

  it("includes /me in the credential deadline and never returns its late response", async () => {
    const me = deferred<Response>();
    fetchMock.mockImplementation((url) =>
      url === "/api/v1/me"
        ? me.promise
        : Promise.resolve(Response.json({ updated: true })),
    );
    const login = signInGoogleCredential(auth, "synthetic-gis-id-token");
    const rejected = expect(login).rejects.toMatchObject({
      code: "google_return_timeout",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    me.resolve(Response.json({ account: { id: "late-user" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(firebaseSessionNeedsReload(auth)).toBe(true);
    await expect(login).rejects.toMatchObject({
      code: "google_return_timeout",
    });
  });

  it("recovers a silent first /me read inside the credential deadline without accepting its late identity", async () => {
    const firstMe = deferred<Response>();
    const verifiedMe = { account: { id: "synthetic-user" } };
    let meReads = 0;
    fetchMock.mockImplementation((url) => {
      if (url !== "/api/v1/me")
        return Promise.resolve(Response.json({ updated: true }));
      meReads += 1;
      return meReads === 1
        ? firstMe.promise
        : Promise.resolve(Response.json(verifiedMe));
    });
    const login = signInGoogleCredential(auth, "synthetic-gis-id-token");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(meReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await login;
    expect(result).toEqual(verifiedMe);
    expect(meReads).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === "/api/v1/auth/google-profile",
      ),
    ).toHaveLength(1);
    firstMe.resolve(Response.json({ account: { id: "late-other-user" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await login).toEqual(verifiedMe);
    expect(auth.currentUser).toBe(user);
    expect(firebaseSessionNeedsReload(auth)).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares duplicate credential callbacks instead of starting two sessions", async () => {
    const first = signInGoogleCredential(auth, "synthetic-gis-id-token");
    const second = signInGoogleCredential(auth, "synthetic-gis-id-token");
    expect(second).toBe(first);
    await first;
    expect(signInWithCredential).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears a rejected credential session without waiting for sign-out", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: "google_identity_mismatch", message: "Rejected" },
        { status: 403 },
      ),
    );
    vi.mocked(signOut).mockReturnValueOnce(new Promise(() => {}));
    await expect(
      signInGoogleCredential(auth, "synthetic-gis-id-token"),
    ).rejects.toMatchObject({
      code: "google_identity_mismatch",
    });
    expect(user.reload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firebaseSessionNeedsReload(auth)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Redirect initialization before the application session observer", () => {
  it("finishes the profile, user reload and token refresh before exposing the session", async () => {
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    redirectResult();
    const onUser = vi.fn();
    const onError = vi.fn();
    const starting = observeFirebaseSession(auth, onUser, onError, () => true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(onUser).not.toHaveBeenCalled();
    release(Response.json({ updated: true }));
    const stop = await starting;
    expect(user.reload).toHaveBeenCalledTimes(1);
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(
      vi.mocked(user.getIdToken).mock.invocationCallOrder.at(-1),
    ).toBeLessThan(vi.mocked(onAuthStateChanged).mock.invocationCallOrder[0]);
    observer()(user);
    expect(onUser).toHaveBeenCalledWith(user, expect.any(Function));
    expect(onError).not.toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("lets a normal page with no redirect observe an existing email session", async () => {
    const onUser = vi.fn();
    const onError = vi.fn();
    await observeFirebaseSession(auth, onUser, onError, () => true);
    observer()(user);
    expect(onUser).toHaveBeenCalledWith(user, expect.any(Function));
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("keeps an error visible and clears authorization when profile verification fails", async () => {
    redirectResult();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          code: "google_identity_mismatch",
          message: "Google 身分與目前登入的帳號不符。",
        },
        { status: 403 },
      ),
    );
    const onUser = vi.fn();
    const onError = vi.fn();
    await observeFirebaseSession(auth, onUser, onError, () => true);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(auth.currentUser).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "google_identity_mismatch" }),
    );
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(onUser).toHaveBeenCalledWith(null, expect.any(Function));
    await api("/config");
    expect(
      fetchMock.mock.calls.at(-1)?.[1].headers.Authorization,
    ).toBeUndefined();
    expect(user.reload).not.toHaveBeenCalled();
    expect(user.getIdToken).not.toHaveBeenCalledWith(true);
  });

  it("allows an explicit email login after a canceled redirect without retrying Google", async () => {
    vi.mocked(getRedirectResult).mockRejectedValueOnce({
      code: "auth/redirect-cancelled-by-user",
    });
    const onUser = vi.fn();
    const onError = vi.fn();
    await observeFirebaseSession(auth, onUser, onError, () => true);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(firebaseSessionNeedsReload(auth)).toBe(false);
    vi.mocked(signInWithEmailAndPassword).mockImplementationOnce(async () => {
      Object.assign(auth, { currentUser: user });
      return { user } as UserCredential;
    });
    configureFirebaseTokenProvider(auth);
    await signInWithEmailAndPassword(
      auth,
      "synthetic@example.invalid",
      "synthetic-password",
    );
    await api("/me");
    expect(onUser).toHaveBeenLastCalledWith(null, expect.any(Function));
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(firebaseSessionNeedsReload(auth)).toBe(false);
    expect(fetchMock.mock.calls.at(-1)?.[1].headers.Authorization).toBe(
      "Bearer synthetic-firebase-token",
    );
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(linkWithPopup).not.toHaveBeenCalled();
    expect(getRedirectResult).toHaveBeenCalledTimes(1);
  });

  it("does not attach an observer for an effect disposed while the shared result is pending", async () => {
    let release!: (value: UserCredential | null) => void;
    vi.mocked(getRedirectResult).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    let active = true;
    const staleUser = vi.fn();
    const currentUser = vi.fn();
    const stale = observeFirebaseSession(
      auth,
      staleUser,
      vi.fn(),
      () => active,
    );
    active = false;
    const current = observeFirebaseSession(
      auth,
      currentUser,
      vi.fn(),
      () => true,
    );
    release({ user } as UserCredential);
    await Promise.all([stale, current]);
    expect(getRedirectResult).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAuthStateChanged).toHaveBeenCalledTimes(1);
    observer()(user);
    expect(staleUser).not.toHaveBeenCalled();
    expect(currentUser).toHaveBeenCalledWith(user, expect.any(Function));
  });

  it("does not deliver observer callbacks after disposal", async () => {
    let active = true;
    const onUser = vi.fn();
    await observeFirebaseSession(auth, onUser, vi.fn(), () => active);
    active = false;
    observer()(user);
    expect(onUser).not.toHaveBeenCalled();
  });

  it("preserves a shared failure instead of treating the second initializer as no result", async () => {
    const error = new Error("Synthetic redirect failure");
    vi.mocked(getRedirectResult).mockRejectedValueOnce(error);
    const first = finishGoogleRedirect(auth);
    const second = finishGoogleRedirect(auth);
    expect(second).toBe(first);
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(getRedirectResult).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("stays signed out in the application even if Firebase sign-out fails", async () => {
    vi.mocked(getRedirectResult).mockRejectedValueOnce(
      new Error("Synthetic failure"),
    );
    vi.mocked(signOut).mockRejectedValueOnce(
      new Error("Synthetic sign-out failure"),
    );
    const onUser = vi.fn();
    const onError = vi.fn();
    await observeFirebaseSession(auth, onUser, onError, () => true);
    expect(onUser).toHaveBeenCalledWith(null, expect.any(Function));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    await api("/config");
    expect(
      fetchMock.mock.calls.at(-1)?.[1].headers.Authorization,
    ).toBeUndefined();
  });
});

describe("Tab session commit and interrupted Google authentication", () => {
  const key = "yzt-google-session:synthetic-auth:";
  function restoredAuth() {
    return {
      name: "synthetic-auth",
      currentUser: user,
      authStateReady: vi.fn().mockResolvedValue(undefined),
    } as unknown as Auth;
  }

  it("writes a quarantine before credential exchange and commits only after the authenticated /me read", async () => {
    const response = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(Response.json({ updated: true }))
      .mockReturnValueOnce(response.promise);
    const login = signInGoogleCredential(auth, "synthetic-google-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(storage.get(key)!)).toEqual({ status: "pending" });
    expect(storage.get(key)).not.toContain("token");
    response.resolve(Response.json({ account: { id: user.uid } }));
    await login;
    expect(JSON.parse(storage.get(key)!)).toEqual({
      status: "ready",
      uid: user.uid,
    });
  });

  it("rejects a refreshed page whose Google profile verification was interrupted", async () => {
    storage.set(key, JSON.stringify({ status: "pending" }));
    Object.assign(user, { providerData: [{ providerId: "google.com" }] });
    const onUser = vi.fn();
    const onError = vi.fn();
    const restored = restoredAuth();
    await observeFirebaseSession(restored, onUser, onError, () => true, true);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("上次 Google 登入未完成"),
      }),
    );
    expect(onAuthStateChanged).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith(restored);
  });

  it("restores a committed Google identity but rejects a marker from another account", async () => {
    Object.assign(user, { providerData: [{ providerId: "google.com" }] });
    storage.set(key, JSON.stringify({ status: "ready", uid: user.uid }));
    await expect(
      finishGoogleRedirect(restoredAuth(), true),
    ).resolves.toBeNull();
    storage.set(key, JSON.stringify({ status: "ready", uid: "another-user" }));
    await expect(finishGoogleRedirect(restoredAuth(), true)).rejects.toThrow(
      "上次 Google 登入未完成",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves to memory before credential exchange if the quarantine cannot be written", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    await signInGoogleCredential(auth, "synthetic-google-token");
    expect(setPersistence).toHaveBeenCalledWith(auth, inMemoryPersistence);
    expect(vi.mocked(setPersistence).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(signInWithCredential).mock.invocationCallOrder[0],
    );
  });

  it("keeps timed-out authentication quarantined across refresh even when SDK sign-out fails", async () => {
    vi.mocked(signInWithCredential).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(signOut).mockRejectedValue(new Error("blocked"));
    const login = signInGoogleCredential(auth, "synthetic-google-token");
    const rejected = expect(login).rejects.toMatchObject({
      code: "google_return_timeout",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(JSON.parse(storage.get(key)!)).toEqual({ status: "pending" });
    await expect(finishGoogleRedirect(restoredAuth(), true)).rejects.toThrow(
      "上次 Google 登入未完成",
    );
  });

  it("clears a completed session on logout and blocks a Google result that arrives afterward", async () => {
    const result = deferred<UserCredential>();
    vi.mocked(signInWithCredential).mockReturnValueOnce(result.promise);
    const login = signInGoogleCredential(auth, "synthetic-google-token");
    const rejected = expect(login).rejects.toMatchObject({
      code: "identity_changed",
    });
    await vi.advanceTimersByTimeAsync(0);
    await clearFirebaseSession(auth);
    Object.assign(auth, { currentUser: user });
    result.resolve({ user } as UserCredential);
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(auth.currentUser).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(key)!)).toEqual({ status: "pending" });
  });

  it("removes the session commit when a normal signed-in user logs out", async () => {
    storage.set(key, JSON.stringify({ status: "ready", uid: user.uid }));
    await clearFirebaseSession(auth);
    expect(storage.has(key)).toBe(false);
    expect(auth.currentUser).toBeNull();
    await api("/config");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("does not clear a newer account when an old Google linking request finishes", async () => {
    vi.mocked(linkWithPopup).mockResolvedValueOnce({ user } as UserCredential);
    const profile = deferred<Response>();
    fetchMock.mockReturnValueOnce(profile.promise);
    const linking = linkGoogle(user, auth);
    const rejected = expect(linking).rejects.toMatchObject({
      code: "identity_changed",
    });
    await vi.advanceTimersByTimeAsync(0);
    const newer = { uid: "synthetic-new-user" } as User;
    Object.assign(auth, { currentUser: newer });
    storage.set(key, JSON.stringify({ status: "ready", uid: newer.uid }));
    profile.resolve(Response.json({ updated: true }));
    await rejected;
    expect(signOut).not.toHaveBeenCalled();
    expect(auth.currentUser).toBe(newer);
    expect(JSON.parse(storage.get(key)!)).toEqual({
      status: "ready",
      uid: newer.uid,
    });
  });

  it("invalidates an older observer callback when a new identity event arrives", async () => {
    const callbacks: Array<() => boolean> = [];
    await observeFirebaseSession(
      auth,
      (_user, current) => {
        callbacks.push(current);
      },
      vi.fn(),
      () => true,
      true,
    );
    observer()(user);
    observer()(null);
    expect(callbacks[0]()).toBe(false);
    expect(callbacks[1]()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
