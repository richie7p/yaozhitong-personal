import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleAuthProvider,
  linkWithPopup,
  signInWithPopup,
  type Auth,
  type User,
  type UserCredential,
} from "firebase/auth";
import {
  configureFirebaseTokenProvider,
  linkGoogle,
  signInGoogle,
} from "../src/google-auth";
import { setTokenProvider } from "../src/api";

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/auth")>()),
  signInWithPopup: vi.fn(),
  linkWithPopup: vi.fn(),
}));

describe("Google popup identity permissions", () => {
  const user = {
    uid: "synthetic-user",
    reload: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue("synthetic-firebase-token"),
  } as unknown as User;
  const auth = { name: "synthetic-auth", currentUser: user } as Auth;
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => Response.json({ updated: true }));
    vi.spyOn(GoogleAuthProvider, "credentialFromResult").mockReturnValue(
      GoogleAuthProvider.credential("synthetic-google-id-token"),
    );
    configureFirebaseTokenProvider(auth);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setTokenProvider(async () => "");
  });

  it.each(["sign-in", "link"] as const)(
    "%s requests email with the real SDK provider without broader Google access",
    async (operation) => {
      const popup = operation === "sign-in" ? signInWithPopup : linkWithPopup;
      const result = { user } as UserCredential;
      vi.mocked(popup).mockResolvedValueOnce(result);

      const returned =
        operation === "sign-in"
          ? await signInGoogle(auth)
          : await linkGoogle(user);

      expect(returned).toBe(result);
      expect(popup).toHaveBeenCalledTimes(1);
      const [target, provider] = vi.mocked(popup).mock.calls[0];
      expect(target).toBe(operation === "sign-in" ? auth : user);
      expect(provider).toBeInstanceOf(GoogleAuthProvider);
      expect(provider.providerId).toBe("google.com");
      expect((provider as GoogleAuthProvider).getScopes().sort()).toEqual([
        "email",
        "profile",
      ]);
    },
  );

  it("does not promote an IdP profile email into Firebase verified identity", async () => {
    // Multiple accounts per email can leave these root fields unset even when
    // the Google provider returns an email. Verification belongs to the server.
    const result = {
      user: {
        ...user,
        uid: "synthetic-google-user",
        email: null,
        emailVerified: false,
        providerData: [
          { providerId: "google.com", email: "synthetic@example.invalid" },
        ],
      },
    } as UserCredential;
    vi.mocked(signInWithPopup).mockResolvedValueOnce(result);
    const returned = await signInGoogle(auth);
    expect(returned.user.email).toBeNull();
    expect(returned.user.emailVerified).toBe(false);
    expect(linkWithPopup).not.toHaveBeenCalled();
  });

  it("restores Firebase authorization after logout cleared the token provider", async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user } as UserCredential);
    await signInGoogle(auth);
    setTokenProvider(async () => "");
    await signInGoogle(auth);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("/api/v1/auth/google-profile");
      expect(options.headers.Authorization).toBe(
        "Bearer synthetic-firebase-token",
      );
      expect(JSON.parse(options.body)).toEqual({
        googleIdToken: "synthetic-google-id-token",
      });
    }
    expect(user.reload).toHaveBeenCalledTimes(2);
    expect(user.getIdToken).toHaveBeenCalledWith(true);
  });

  it("waits for profile bootstrap before refreshing the user and resolving login", async () => {
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    vi.mocked(signInWithPopup).mockResolvedValueOnce({
      user,
    } as UserCredential);
    let completed = false;
    const login = signInGoogle(auth).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    expect(user.reload).not.toHaveBeenCalled();
    release(Response.json({ updated: true }));
    await login;
    expect(user.reload).toHaveBeenCalledTimes(1);
    expect(user.getIdToken).toHaveBeenLastCalledWith(true);
    expect(completed).toBe(true);
  });

  it("propagates bootstrap failure so the login form can display it", async () => {
    vi.mocked(signInWithPopup).mockResolvedValueOnce({
      user,
    } as UserCredential);
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: "google_identity_mismatch", message: "身分與目前帳號不符。" },
        { status: 403 },
      ),
    );
    await expect(signInGoogle(auth)).rejects.toMatchObject({
      code: "google_identity_mismatch",
    });
    expect(user.reload).not.toHaveBeenCalled();
    expect(user.getIdToken).not.toHaveBeenCalledWith(true);
  });

  it("does not substitute a Firebase token when Google omitted its ID token", async () => {
    vi.mocked(signInWithPopup).mockResolvedValueOnce({
      user,
    } as UserCredential);
    vi.mocked(GoogleAuthProvider.credentialFromResult).mockReturnValueOnce(
      null,
    );
    await expect(signInGoogle(auth)).rejects.toThrow("完整登入憑證");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps canceled sign-in retryable without falling back to another identity", async () => {
    const cancellation = { code: "auth/popup-closed-by-user" };
    vi.mocked(signInWithPopup).mockRejectedValueOnce(cancellation);
    await expect(signInGoogle(auth)).rejects.toBe(cancellation);
    expect(signInWithPopup).toHaveBeenCalledTimes(1);
    expect(linkWithPopup).not.toHaveBeenCalled();
  });

  it("preserves an explicit link conflict instead of signing into the other account", async () => {
    const conflict = { code: "auth/credential-already-in-use" };
    vi.mocked(linkWithPopup).mockRejectedValueOnce(conflict);
    await expect(linkGoogle(user)).rejects.toBe(conflict);
    expect(linkWithPopup).toHaveBeenCalledTimes(1);
    expect(signInWithPopup).not.toHaveBeenCalled();
  });
});
