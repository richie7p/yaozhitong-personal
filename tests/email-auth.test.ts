import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
  type UserCredential,
} from "firebase/auth";
import { refreshEmailVerification, signInEmail } from "../src/email-auth";
import { authErrorMessage } from "../src/auth-errors";
import { readTabValue, writeTabValue } from "../src/session-storage";

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));

let user: User;
let auth: Auth;
beforeEach(() => {
  vi.resetAllMocks();
  user = {
    uid: "synthetic-email",
    emailVerified: false,
    reload: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue("synthetic-token"),
  } as unknown as User;
  auth = { currentUser: user } as Auth;
  vi.mocked(createUserWithEmailAndPassword).mockResolvedValue({
    user,
  } as UserCredential);
  vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
    user,
  } as UserCredential);
  vi.mocked(sendEmailVerification).mockResolvedValue(undefined);
  vi.mocked(sendPasswordResetEmail).mockResolvedValue(undefined);
  vi.mocked(signOut).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("Email sign-in, registration and recovery", () => {
  it("trims email while retaining existing short passwords at sign-in", async () => {
    await signInEmail(auth, "login", " person@example.invalid ", "six123");
    expect(signInWithEmailAndPassword).toHaveBeenCalledWith(
      auth,
      "person@example.invalid",
      "six123",
    );
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it("rejects a weak registration before creating an account", async () => {
    await expect(
      signInEmail(auth, "register", "person@example.invalid", "short"),
    ).rejects.toMatchObject({ code: "auth/weak-password" });
    expect(createUserWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it("registers and sends verification exactly once", async () => {
    await expect(
      signInEmail(
        auth,
        "register",
        "person@example.invalid",
        "synthetic-password",
      ),
    ).resolves.toBe("");
    expect(sendEmailVerification).toHaveBeenCalledExactlyOnceWith(user);
  });

  it("keeps the created account usable and explains how to resend when mail delivery fails", async () => {
    vi.mocked(sendEmailVerification).mockRejectedValue({
      code: "auth/network-request-failed",
    });
    const warning = await signInEmail(
      auth,
      "register",
      "person@example.invalid",
      "synthetic-password",
    );
    expect(warning).toContain("帳號已建立");
    expect(warning).toContain("帳號與設定重新寄送");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("surfaces duplicate accounts without sending verification", async () => {
    const duplicate = { code: "auth/email-already-in-use" };
    vi.mocked(createUserWithEmailAndPassword).mockRejectedValue(duplicate);
    await expect(
      signInEmail(
        auth,
        "register",
        "person@example.invalid",
        "synthetic-password",
      ),
    ).rejects.toBe(duplicate);
    expect(sendEmailVerification).not.toHaveBeenCalled();
    expect(authErrorMessage(duplicate)).toContain("重設信");
  });

  it("gives the same reset confirmation for an unknown account but preserves network failures", async () => {
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce({
      code: "auth/user-not-found",
    });
    await expect(
      signInEmail(auth, "reset", " nobody@example.invalid ", ""),
    ).resolves.toBe("");
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      auth,
      "nobody@example.invalid",
    );
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce({
      code: "auth/network-request-failed",
    });
    await expect(
      signInEmail(auth, "reset", "person@example.invalid", ""),
    ).rejects.toMatchObject({ code: "auth/network-request-failed" });
  });

  it("signs out a late SDK login when the user already logged out", async () => {
    const stale = new Error("stale");
    await expect(
      signInEmail(
        auth,
        "login",
        "person@example.invalid",
        "synthetic-password",
        () => {
          throw stale;
        },
      ),
    ).rejects.toBe(stale);
    expect(signOut).toHaveBeenCalledExactlyOnceWith(auth);
  });

  it("does not sign out a newer account when an older login is discarded", async () => {
    Object.assign(auth, { currentUser: { uid: "synthetic-newer-user" } });
    await expect(
      signInEmail(
        auth,
        "login",
        "person@example.invalid",
        "synthetic-password",
        () => {
          throw new Error("stale");
        },
      ),
    ).rejects.toThrow("stale");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("returns verification and reset actions to fixed routes on this site's origin", async () => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://synthetic.example.invalid",
        href: "https://synthetic.example.invalid/?return=https://elsewhere.invalid/#chat",
      },
    });
    await signInEmail(
      auth,
      "register",
      "person@example.invalid",
      "synthetic-password",
    );
    expect(sendEmailVerification).toHaveBeenCalledWith(user, {
      url: "https://synthetic.example.invalid/#profile",
      handleCodeInApp: false,
    });
    await refreshEmailVerification(auth, () => {});
    expect(sendEmailVerification).toHaveBeenLastCalledWith(user, {
      url: "https://synthetic.example.invalid/#profile",
      handleCodeInApp: false,
    });
    await signInEmail(auth, "reset", "person@example.invalid", "");
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      auth,
      "person@example.invalid",
      {
        url: "https://synthetic.example.invalid/#home",
        handleCodeInApp: false,
      },
    );
  });

  it("refreshes Firebase and forces a fresh token before recognizing a verified email", async () => {
    vi.mocked(user.reload).mockImplementationOnce(async () => {
      Object.assign(user, { emailVerified: true });
    });
    await refreshEmailVerification(auth, () => {});
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(sendEmailVerification).not.toHaveBeenCalled();
    expect(vi.mocked(user.reload).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(user.getIdToken).mock.invocationCallOrder[0],
    );
  });

  it("resends only for an unverified user and stops after an account switch", async () => {
    await refreshEmailVerification(auth, () => {});
    expect(sendEmailVerification).toHaveBeenCalledExactlyOnceWith(user);
    vi.mocked(sendEmailVerification).mockClear();
    vi.mocked(user.reload).mockImplementationOnce(async () => {
      Object.assign(auth, { currentUser: null });
    });
    await expect(refreshEmailVerification(auth, () => {})).rejects.toThrow(
      "登入狀態已變更",
    );
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it("keeps authentication usable in memory when sessionStorage is blocked and clears logout values", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw Error("blocked");
      },
      setItem: () => {
        throw Error("blocked");
      },
      removeItem: () => {
        throw Error("blocked");
      },
    });
    writeTabValue("synthetic-auth-fallback", "synthetic-token");
    expect(readTabValue("synthetic-auth-fallback")).toBe("synthetic-token");
    writeTabValue("synthetic-auth-fallback", null);
    expect(readTabValue("synthetic-auth-fallback")).toBeNull();
  });

  it.each([
    "auth/network-request-failed",
    "auth/too-many-requests",
    "auth/popup-closed-by-user",
    "auth/popup-blocked",
    "auth/invalid-credential",
  ])(
    "maps %s to a useful message without leaking Firebase internals",
    (code) => {
      const message = authErrorMessage(
        Object.assign(new Error("Firebase synthetic private detail"), { code }),
      );
      expect(message).not.toContain("Firebase");
      expect(message.length).toBeGreaterThan(8);
    },
  );
});
