export function authErrorMessage(error: unknown) {
  const code = String((error as { code?: string } | null)?.code || "");
  const messages: Record<string, string> = {
    "auth/invalid-credential": "信箱或密碼不正確。",
    "auth/invalid-login-credentials": "信箱或密碼不正確。",
    "auth/user-not-found": "信箱或密碼不正確。",
    "auth/wrong-password": "信箱或密碼不正確。",
    "auth/invalid-email": "請填寫完整的電子信箱。",
    "auth/missing-password": "請填寫密碼。",
    "auth/email-already-in-use":
      "此信箱已有帳號，請登入原帳號；若忘記密碼，可寄送重設信。",
    "auth/weak-password": "密碼強度不足，請至少使用 8 個字元。",
    "auth/password-does-not-meet-requirements":
      "密碼不符合安全要求，請增加長度並混合大小寫、數字或符號。",
    "auth/network-request-failed": "無法連線到登入服務，請確認網路後重試。",
    "auth/too-many-requests": "操作太頻繁，請稍候再試。",
    "auth/user-disabled": "此帳號已停用，請聯絡管理員。",
    "auth/operation-not-allowed":
      "此登入方式尚未開通，請使用其他方式或聯絡管理員。",
    "auth/unauthorized-continue-uri":
      "驗證信的返回網站尚未開通，請聯絡管理員確認本站的 Firebase 授權網域。",
    "auth/invalid-continue-uri": "驗證信的返回網站設定無法使用，請聯絡管理員。",
    "auth/popup-closed-by-user": "登入視窗已關閉，可重試或使用電子信箱登入。",
    "auth/cancelled-popup-request":
      "Google 登入已取消，可重試或使用電子信箱登入。",
    "auth/redirect-cancelled-by-user":
      "Google 登入已取消，可重試或使用電子信箱登入。",
    "auth/popup-blocked":
      "瀏覽器阻擋登入視窗，請允許彈出視窗後重試，或使用電子信箱登入。",
    "auth/account-exists-with-different-credential":
      "此信箱已有其他登入方式，請用原方式登入後，到設定連結 Google。",
    "auth/credential-already-in-use":
      "此登入方式已連結其他帳號，請登入原帳號。",
    "auth/requires-recent-login": "為了確認身分，請重新登入後再操作。",
    "auth/user-token-expired": "登入已失效，請重新登入。",
  };
  if (messages[code]) return messages[code];
  if (code.startsWith("auth/"))
    return "登入服務暫時無法完成操作，請稍後重試或使用其他登入方式。";
  return error instanceof Error ? error.message : "操作未完成，請重試。";
}
