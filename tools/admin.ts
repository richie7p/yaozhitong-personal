import { getAuth } from "firebase-admin/auth";
import { config } from "../server/config.js";
import { firebaseApp, makeStore } from "../server/store.js";
const [uid] = process.argv.slice(2);
if (!uid) throw Error("Usage: npm run admin -- FIREBASE_UID");
if (config.mode !== "firebase")
  throw Error(
    "Bootstrap admin requires APP_MODE=firebase; local mode has its own admin.",
  );
const auth = getAuth(firebaseApp());
const u = await auth.getUser(uid);
await auth.setCustomUserClaims(uid, { ...u.customClaims, admin: true });
const store = await makeStore();
const row = await store.get("users", uid);
if (row) await store.set("users", uid, { ...row, admin: true });
console.log("Admin role assigned. Sign out and sign in to refresh the token.");
