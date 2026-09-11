import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { OAuth2Client } from "google-auth-library";
import type { Identity } from "../shared/schema.js";
import { config, fail } from "./config.js";
import { firebaseApp } from "./store.js";
const secret = randomBytes(32);
export const localPeople = [
  {
    uid: "local-owner",
    email: "owner@example.test",
    name: "本機使用者",
    verified: true,
    admin: false,
  },
  {
    uid: "local-family",
    email: "family@example.test",
    name: "本機家人",
    verified: true,
    admin: false,
  },
  {
    uid: "local-admin",
    email: "admin@example.test",
    name: "本機管理員",
    verified: true,
    admin: true,
  },
];
export function localToken(uid: string) {
  const p =
    localPeople.find((x) => x.uid === uid) ||
    fail("invalid_account", "無此本機帳號");
  const body = Buffer.from(
    JSON.stringify({ ...p, exp: Date.now() + 8 * 3600000 }),
  ).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export async function authenticate(token: string): Promise<Identity> {
  if (!token) return fail("unauthenticated", "請先登入。", 401);
  if (config.mode === "local") {
    const [body, sig] = token.split(".");
    const expected = createHmac("sha256", secret)
      .update(body || "")
      .digest("base64url");
    if (
      !sig ||
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return fail("unauthenticated", "登入已失效。", 401);
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.exp < Date.now()) return fail("unauthenticated", "請重新登入。", 401);
    return p;
  }
  try {
    const d = await getAuth(firebaseApp()).verifyIdToken(token, true);
    return {
      uid: d.uid,
      email: d.email || "",
      name: d.name || "使用者",
      verified: d.email_verified === true,
      admin: d.admin === true,
    };
  } catch {
    return fail("unauthenticated", "登入已失效，請重新登入。", 401);
  }
}
export async function verifyWorker(token: string) {
  if (!config.workerUrl || !config.workerEmail)
    return fail("worker_not_configured", "工作服務未設定。", 503);
  try {
    const t = await new OAuth2Client().verifyIdToken({
      idToken: token,
      audience: config.workerUrl,
    });
    const p = t.getPayload();
    if (p?.email !== config.workerEmail || !p.email_verified) throw Error();
  } catch {
    return fail("forbidden", "拒絕工作服務請求。", 403);
  }
}
