import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAuth2Client,
  type LoginTicket,
  type TokenPayload,
} from "google-auth-library";
import { config, fail } from "../server/config";
import { completeGoogleProfile } from "../server/google-profile";
import { createApp } from "../server/app";
import { Domain } from "../server/domain";
import { MemoryStore } from "../server/store";

const admin = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => admin }));
vi.mock("../server/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/store")>()),
  firebaseApp: () => ({ name: "synthetic-app" }),
}));

const clientId = "synthetic-client.apps.googleusercontent.com";
const googleIdToken = "synthetic-sensitive-google-token";
const original = { mode: config.mode, clientId: config.googleOAuthClientId };
let claims: TokenPayload;
let firebaseUser: Record<string, any>;
let verify: ReturnType<typeof vi.spyOn>;
const active = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  config.mode = "firebase";
  config.googleOAuthClientId = clientId;
  const time = Math.floor(Date.now() / 1000);
  claims = {
    sub: "google-sub-a",
    aud: clientId,
    iss: "https://accounts.google.com",
    iat: time,
    exp: time + 3600,
    email: "synthetic@example.invalid",
    email_verified: true,
    name: "Synthetic Person",
  };
  firebaseUser = {
    uid: "firebase-a",
    disabled: false,
    email: undefined,
    displayName: undefined,
    providerData: [{ providerId: "google.com", uid: "google-sub-a" }],
  };
  admin.getUser.mockImplementation(async () => firebaseUser);
  admin.updateUser.mockResolvedValue({});
  active.mockResolvedValue({});
  verify = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
  verify.mockImplementation(
    async () => ({ getPayload: () => claims }) as LoginTicket,
  );
});
afterEach(() => {
  config.mode = original.mode;
  config.googleOAuthClientId = original.clientId;
  vi.restoreAllMocks();
});

describe("Google profile completion bound to the authenticated Firebase user", () => {
  it("publishes the Google client ID with an origin-only cross-site referrer policy", async () => {
    const app = createApp(new Domain(new MemoryStore()));
    const response = await app.request("/api/v1/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).googleOAuthClientId).toBe(clientId);
  });

  it("verifies the configured audience and matching Google sub before filling a missing email", async () => {
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).resolves.toEqual({
      updated: true,
      emailPreserved: false,
    });
    expect(verify).toHaveBeenCalledWith({
      idToken: googleIdToken,
      audience: clientId,
    });
    expect(admin.getUser).toHaveBeenCalledWith("firebase-a");
    expect(active).toHaveBeenCalledTimes(1);
    expect(admin.updateUser).toHaveBeenCalledWith("firebase-a", {
      email: "synthetic@example.invalid",
      emailVerified: true,
      displayName: "Synthetic Person",
    });
  });

  it.each([
    ["same verified", "synthetic@example.invalid", true],
    ["same unverified", "synthetic@example.invalid", false],
    ["different password", "original@example.invalid", false],
  ])(
    "preserves the existing %s root email and verification flag",
    async (_label, email, emailVerified) => {
      firebaseUser.email = email;
      firebaseUser.emailVerified = emailVerified;
      await expect(
        completeGoogleProfile("firebase-a", { googleIdToken }, active),
      ).resolves.toEqual({
        updated: false,
        emailPreserved: true,
      });
      expect(admin.updateUser).not.toHaveBeenCalled();
      expect(firebaseUser.emailVerified).toBe(emailVerified);
    },
  );

  it("preserves an existing display name", async () => {
    firebaseUser.displayName = "Existing Name";
    await completeGoogleProfile("firebase-a", { googleIdToken }, active);
    expect(admin.updateUser).toHaveBeenCalledWith("firebase-a", {
      email: "synthetic@example.invalid",
      emailVerified: true,
    });
  });

  it.each([
    { sub: "someone-elses-google-sub" },
    { email_verified: false },
    { email_verified: "true" },
    { email: "" },
    { email: "not-an-email" },
    { aud: "another-project.apps.googleusercontent.com" },
    { iss: "https://attacker.example.invalid" },
    { exp: 1 },
    { iat: 9999999999 },
  ])(
    "rejects an unverified or mismatched proof %j without modifying an account",
    async (change) => {
      Object.assign(claims, change);
      await expect(
        completeGoogleProfile("firebase-a", { googleIdToken }, active),
      ).rejects.toMatchObject({
        status: change.sub ? 403 : 401,
      });
      expect(admin.updateUser).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing Google provider even with a valid Google email proof", async () => {
    firebaseUser.providerData = [
      { providerId: "password", uid: "google-sub-a" },
    ];
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toMatchObject({
      code: "google_identity_mismatch",
    });
    expect(admin.updateUser).not.toHaveBeenCalled();
  });

  it("rejects disabled accounts and accounts disabled while Google verification ran", async () => {
    firebaseUser.disabled = true;
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toMatchObject({
      code: "account_disabled",
    });
    firebaseUser.disabled = false;
    active.mockRejectedValueOnce(new Error("account no longer active"));
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toThrow("account no longer active");
    expect(admin.updateUser).not.toHaveBeenCalled();
  });

  it("fails closed without a configured client ID or in local mode", async () => {
    config.googleOAuthClientId = "";
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toMatchObject({
      code: "google_profile_not_configured",
      status: 503,
    });
    config.googleOAuthClientId = clientId;
    config.mode = "local";
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(admin.getUser).not.toHaveBeenCalled();
  });

  it("sanitizes signature/expiry verification errors and does not attempt Admin updates", async () => {
    verify.mockRejectedValueOnce(
      new Error("invalid signature: " + googleIdToken),
    );
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toMatchObject({
      code: "google_identity_invalid",
      message: expect.not.stringContaining(googleIdToken),
    });
    expect(admin.getUser).not.toHaveBeenCalled();
    expect(admin.updateUser).not.toHaveBeenCalled();
  });

  it("does not expose provider errors or auto-merge an email conflict", async () => {
    admin.updateUser.mockRejectedValueOnce(
      new Error("email conflict: synthetic@example.invalid " + googleIdToken),
    );
    await expect(
      completeGoogleProfile("firebase-a", { googleIdToken }, active),
    ).rejects.toMatchObject({
      code: "google_profile_update_failed",
      status: 409,
      message: expect.not.stringContaining("synthetic@example.invalid"),
    });
    expect(admin.updateUser).toHaveBeenCalledTimes(1);
  });

  it("requires Firebase authentication but accepts an unverified account for bootstrap", async () => {
    const store = new MemoryStore();
    const identity = {
      uid: "firebase-a",
      email: "",
      name: "Test",
      verified: false,
      admin: false,
    };
    const app = createApp(new Domain(store), async (token) => {
      if (token !== "synthetic-firebase-token")
        return fail("unauthenticated", "請先登入。", 401);
      return identity;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = (body: unknown, authenticated = true) =>
      app.request("/api/v1/auth/google-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated
            ? { Authorization: "Bearer synthetic-firebase-token" }
            : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await request({ googleIdToken }, false)).status).toBe(401);
    expect(admin.updateUser).not.toHaveBeenCalled();
    expect(
      (await request({ googleIdToken, uid: "another-firebase-user" })).status,
    ).toBe(400);
    expect(admin.updateUser).not.toHaveBeenCalled();
    const response = await request({ googleIdToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updated: true,
      emailPreserved: false,
    });
    expect(admin.updateUser.mock.calls[0][0]).toBe("firebase-a");
    expect(JSON.stringify(store.data)).not.toContain(googleIdToken);
    expect(JSON.stringify(log.mock.calls)).not.toContain(googleIdToken);
  });
});
