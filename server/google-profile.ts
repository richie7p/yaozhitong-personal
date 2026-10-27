import { getAuth } from "firebase-admin/auth";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { z } from "zod";
import { config, fail } from "./config.js";
import { firebaseApp } from "./store.js";

// Reuse the verifier so Google's public signing certificates can be cached.
// The Google credential is verified in memory and is never logged or stored.
const verifier = new OAuth2Client({
  transporterOptions: { timeout: 10000, retryConfig: { retry: 0 } },
});
const requestSchema = z
  .object({ googleIdToken: z.string().min(1).max(16000) })
  .strict();
const emailSchema = z.string().email().max(254);

export async function completeGoogleProfile(
  uid: string,
  input: unknown,
  assertActive: () => Promise<unknown>,
) {
  if (config.mode !== "firebase") return fail("not_found", "沒有此端點。", 404);
  if (
    !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
      config.googleOAuthClientId,
    )
  )
    return fail(
      "google_profile_not_configured",
      "Google 登入設定尚未完成，請稍後重試。",
      503,
    );
  const { googleIdToken } = requestSchema.parse(input);
  let claims: TokenPayload | undefined;
  try {
    const ticket = await verifier.verifyIdToken({
      idToken: googleIdToken,
      audience: config.googleOAuthClientId,
    });
    claims = ticket.getPayload();
  } catch {
    return fail(
      "google_identity_invalid",
      "無法確認 Google 登入身分，請重新登入。",
      401,
    );
  }
  const currentTime = Math.floor(Date.now() / 1000);
  if (
    !claims ||
    claims.aud !== config.googleOAuthClientId ||
    !["accounts.google.com", "https://accounts.google.com"].includes(
      claims.iss,
    ) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= currentTime ||
    !Number.isFinite(claims.iat) ||
    claims.iat > currentTime + 300 ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.email_verified !== true ||
    !emailSchema.safeParse(claims.email).success
  )
    return fail(
      "google_identity_invalid",
      "Google 未提供可確認的已驗證信箱，請重新登入。",
      401,
    );

  // Recheck account status after certificate verification, then read the
  // current Firebase user immediately before considering an update.
  await assertActive();
  const auth = getAuth(firebaseApp());
  let user;
  try {
    user = await auth.getUser(uid);
  } catch {
    return fail(
      "google_profile_unavailable",
      "無法確認帳號，請重新登入。",
      409,
    );
  }
  if (user.disabled) return fail("account_disabled", "帳號已停用。", 403);
  if (
    user.uid !== uid ||
    !user.providerData.some(
      (provider) =>
        provider.providerId === "google.com" && provider.uid === claims.sub,
    )
  )
    return fail(
      "google_identity_mismatch",
      "Google 身分與目前登入的帳號不符。",
      403,
    );

  // Linking Google must not replace or verify an existing password email,
  // including a different address or an address still awaiting verification.
  if (user.email) return { updated: false, emailPreserved: true };
  const displayName =
    !user.displayName && typeof claims.name === "string"
      ? claims.name.trim().slice(0, 100)
      : "";
  try {
    await auth.updateUser(uid, {
      email: claims.email,
      emailVerified: true,
      ...(displayName ? { displayName } : {}),
    });
  } catch {
    // Firebase error messages can contain an address or credential detail.
    return fail(
      "google_profile_update_failed",
      "Google 帳號資料尚未完成，請重新登入後再試。",
      409,
    );
  }
  return { updated: true, emailPreserved: false };
}
