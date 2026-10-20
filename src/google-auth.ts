import {
  GoogleAuthProvider,
  linkWithPopup,
  signInWithPopup,
  type Auth,
  type User,
  type UserCredential,
} from "firebase/auth";
import { api, setTokenProvider } from "./api";

export function configureFirebaseTokenProvider(auth: Auth) {
  setTokenProvider(async () =>
    auth.currentUser ? auth.currentUser.getIdToken() : "",
  );
}

function googleProvider() {
  const provider = new GoogleAuthProvider();
  // The SDK requests profile by default. Email must be explicit when Firebase
  // allows separate accounts for different providers using the same address.
  // This scope does not replace the backend's verified-email check.
  provider.addScope("email");
  return provider;
}

async function completeProfile(result: UserCredential) {
  const googleIdToken =
    GoogleAuthProvider.credentialFromResult(result)?.idToken;
  if (!googleIdToken)
    throw new Error("Google 未提供完整登入憑證，請重新登入。");
  await api("/auth/google-profile", "POST", { googleIdToken });
  await result.user.reload();
  await result.user.getIdToken(true);
  return result;
}

export async function signInGoogle(auth: Auth) {
  configureFirebaseTokenProvider(auth);
  return completeProfile(await signInWithPopup(auth, googleProvider()));
}

export async function linkGoogle(user: User) {
  return completeProfile(await linkWithPopup(user, googleProvider()));
}
