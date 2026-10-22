import { expect, test, type Page } from "@playwright/test";

// Every Firebase/Google request is fulfilled locally. No account, email or
// identity credential in this fixture reaches an external service.
async function syntheticAuth(page: Page, publicAccess = "approved") {
  let uid = "synthetic-email-user";
  let email = "person@example.invalid";
  let verified = true;
  let google = false;
  let linkedGoogle = false;
  let failMe = false;
  let duplicate = false;
  let failVerification = false;
  let holdGoogle = false;
  let releaseGoogle: (() => void) | undefined;
  let profileReads = 0;
  const oob: string[] = [];
  const continueUrls: string[] = [];
  const deviceDeletes: string[] = [];
  let deviceDeleteGate: Promise<void> | undefined;
  const requests: string[] = [];
  const token = () => {
    const now = Math.floor(Date.now() / 1000);
    return (
      [
        { alg: "RS256", typ: "JWT" },
        {
          sub: uid,
          user_id: uid,
          email,
          email_verified: verified,
          iat: now,
          exp: now + 3600,
          auth_time: now,
          firebase: { sign_in_provider: google ? "google.com" : "password" },
        },
      ]
        .map((value) =>
          Buffer.from(JSON.stringify(value)).toString("base64url"),
        )
        .join(".") + ".synthetic-signature"
    );
  };
  const user = () => ({
    localId: uid,
    email,
    emailVerified: verified,
    displayName: uid,
    providerUserInfo: [
      {
        providerId: google ? "google.com" : "password",
        rawId: google ? "synthetic-google-sub" : email,
        email,
        displayName: uid,
      },
      ...(linkedGoogle && !google
        ? [
            {
              providerId: "google.com",
              rawId: "synthetic-linked-google-sub",
              email,
              displayName: uid,
            },
          ]
        : []),
    ],
    passwordUpdatedAt: Date.now(),
    lastLoginAt: String(Date.now()),
    createdAt: String(Date.now()),
  });
  await page.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.hostname + url.pathname);
    if (
      url.hostname === "accounts.google.com" &&
      url.pathname === "/gsi/client"
    ) {
      await route.fulfill({
        contentType: "text/javascript",
        body: `
        let callback;
        window.google={accounts:{id:{initialize(options){callback=options.callback},renderButton(element,options){
          const button=document.createElement('button');button.textContent='Google 合成測試登入';
          button.onclick=()=>callback({credential:'synthetic-google-id-token',state:options.state});element.append(button);
        }}}};`,
      });
      return;
    }
    if (url.hostname === "identitytoolkit.googleapis.com") {
      const body = route.request().postDataJSON();
      if (url.pathname.endsWith("accounts:signUp") && duplicate) {
        await route.fulfill({
          status: 400,
          json: { error: { message: "EMAIL_EXISTS" } },
        });
        return;
      }
      if (url.pathname.endsWith("accounts:lookup")) {
        await route.fulfill({ json: { users: [user()] } });
        return;
      }
      if (url.pathname.endsWith("accounts:sendOobCode")) {
        oob.push(body.requestType);
        continueUrls.push(body.continueUrl);
        await route.fulfill(
          failVerification && body.requestType === "VERIFY_EMAIL"
            ? {
                status: 400,
                json: { error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" } },
              }
            : { json: { email } },
        );
        return;
      }
      google = url.pathname.endsWith("accounts:signInWithIdp");
      if (body.email) email = body.email;
      if (url.pathname.endsWith("accounts:signUp")) verified = false;
      uid = google
        ? "synthetic-google-user"
        : email.startsWith("other")
          ? "synthetic-other-user"
          : "synthetic-email-user";
      await route.fulfill({
        json: {
          ...user(),
          idToken: token(),
          refreshToken: "synthetic-refresh-token",
          expiresIn: "3600",
          providerId: google ? "google.com" : "password",
        },
      });
      return;
    }
    if (url.hostname === "securetoken.googleapis.com") {
      await route.fulfill({
        json: {
          access_token: token(),
          refresh_token: "synthetic-refresh-token",
          expires_in: "3600",
          user_id: uid,
          token_type: "Bearer",
          project_id: "synthetic-project",
        },
      });
      return;
    }
    await route.abort();
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/config")) {
      await route.fulfill({
        json: {
          mode: "firebase",
          publicAccess,
          dailyUserLimit: 20,
          dailyGlobalLimit: 1000,
          googleOAuthClientId: "synthetic-client.apps.googleusercontent.com",
          firebase: {
            apiKey: "synthetic-api-key",
            authDomain: "synthetic.invalid",
            projectId: "synthetic-project",
            appId: "synthetic-app",
          },
        },
      });
    } else if (path.endsWith("/auth/google-profile")) {
      profileReads++;
      if (holdGoogle)
        await new Promise<void>((resolve) => {
          releaseGoogle = resolve;
        });
      await route.fulfill({ json: { updated: true } }).catch(() => {});
    } else if (path.endsWith("/me")) {
      await route.fulfill(
        failMe
          ? {
              status: 503,
              json: {
                code: "synthetic_unavailable",
                message: "合成服務暫時無法連線，請重試。",
              },
            }
          : {
              json: {
                account: {
                  id: uid,
                  email,
                  displayName: uid,
                  eligible: false,
                  admin: false,
                },
                profile: null,
              },
            },
      );
    } else {
      if (route.request().method() === "DELETE" && path.includes("/devices/")) {
        deviceDeletes.push(route.request().headers().authorization || "");
        await deviceDeleteGate;
      }
      await route.fulfill({ json: { items: [] } });
    }
  });
  return {
    oob,
    continueUrls,
    deviceDeletes,
    holdDeviceDeletion: () => {
      let release!: () => void;
      deviceDeleteGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    requests,
    duplicate: (value: boolean) => {
      duplicate = value;
    },
    verified: (value: boolean) => {
      verified = value;
    },
    failVerification: (value: boolean) => {
      failVerification = value;
    },
    failMe: (value: boolean) => {
      failMe = value;
    },
    holdGoogle: () => {
      holdGoogle = true;
    },
    releaseGoogle: () => releaseGoogle?.(),
    profileReads: () => profileReads,
    linkGoogleProvider: () => {
      linkedGoogle = true;
    },
  };
}

async function fillEmail(
  page: Page,
  email = "person@example.invalid",
  password = "six123",
) {
  await page
    .getByRole("textbox", { name: "電子信箱", exact: true })
    .fill(email);
  const passwordField = page.getByLabel("密碼", { exact: true });
  if (await passwordField.count()) await passwordField.fill(password);
}

async function expectPrimaryInFirstScreen(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const primary = page.getByRole("button", { name, exact: true });
  await expect(primary).toBeVisible();
  await expect(primary).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("narrow auth forms explain registration and reset without hiding the primary action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 757 });
  await syntheticAuth(page);
  await page.goto("/");
  await expect(
    page.getByText("開啟你的藥品、說明與服藥紀錄。", { exact: true }),
  ).toBeVisible();
  await expectPrimaryInFirstScreen(page, "登入");

  await page.getByRole("button", { name: "建立新帳號", exact: true }).click();
  await expect(
    page.getByText("先建立帳號並驗證信箱，再確認 AI 試用資格。", {
      exact: true,
    }),
  ).toBeVisible();
  const password = page.getByLabel("密碼", { exact: true });
  const passwordHelp = page.locator("#register-password-help");
  await expect(passwordHelp).toHaveText("至少 8 個字元。");
  await expect(password).toHaveAttribute(
    "aria-describedby",
    /(?:^|\s)register-password-help(?:\s|$)/,
  );
  await expect(password).toHaveAccessibleDescription("至少 8 個字元。");
  await password.fill("synthetic-password");
  await expect(passwordHelp).toBeVisible();
  await expect(page.locator("#registration-trial-notice")).toHaveText(
    "目前為受控試用。完成註冊與信箱驗證後，仍需另行取得 AI 試用資格，才能使用 AI 功能。",
  );
  await expect(page.locator("#registration-trial-notice")).toBeInViewport({
    ratio: 1,
  });
  await expectPrimaryInFirstScreen(page, "建立帳號");

  await page.getByRole("button", { name: "忘記密碼？", exact: true }).click();
  await expect(
    page.getByText("輸入註冊時使用的信箱，我們會寄送重設密碼連結。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "忘記密碼？", exact: true }),
  ).toHaveCount(0);
  await expectPrimaryInFirstScreen(page, "寄送重設信");
});

test("desktop password visibility preserves input and never submits either auth form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 757 });
  const fixture = await syntheticAuth(page);
  await page.goto("/");

  for (const mode of ["login", "register"] as const) {
    if (mode === "register") {
      await page
        .getByRole("button", { name: "建立新帳號", exact: true })
        .click();
    }
    const value = `synthetic-${mode}-password`;
    await fillEmail(page, "person@example.invalid", value);
    const password = page.getByLabel("密碼", { exact: true });
    const show = page.getByRole("button", { name: "顯示密碼", exact: true });
    await expect(show).toHaveAttribute("type", "button");
    await expect(show).toHaveAttribute("aria-pressed", "false");
    await expect(password).toHaveAttribute("type", "password");
    await show.click();

    const hide = page.getByRole("button", { name: "隱藏密碼", exact: true });
    await expect(hide).toHaveAttribute("type", "button");
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue(value);
    await hide.click();
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue(value);
    await expect(show).toHaveAttribute("aria-pressed", "false");
    await expectPrimaryInFirstScreen(
      page,
      mode === "register" ? "建立帳號" : "登入",
    );
  }
  expect(
    fixture.requests.filter((request) =>
      /identitytoolkit\.googleapis\.com\/.*accounts:/.test(request),
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: "忘記密碼？", exact: true }).click();
  await expectPrimaryInFirstScreen(page, "寄送重設信");
});

test("email login survives refresh, keeps questions in memory, clears logout and isolates the next account", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await syntheticAuth(page);
  fixture.linkGoogleProvider();
  await page.goto("/#chat");
  await fillEmail(page);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用藥問答", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "用藥問題", exact: true })
    .fill("合成健康問題不應儲存");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "用藥問答", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "用藥問題", exact: true }),
  ).toHaveValue("");
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...sessionStorage, ...localStorage }),
  );
  expect(stored).not.toContain("合成健康問題");
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "登入", exact: true }),
  ).toBeVisible();
  await fillEmail(page, "other@example.invalid");
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await expect(page.locator(".user-name")).toHaveText("synthetic-other-user");
  await page.goto("/#chat");
  await expect(
    page.getByRole("textbox", { name: "用藥問題", exact: true }),
  ).toHaveValue("");
  expect(errors).toEqual([]);
});

test("registration handles duplicates, mail failure, resend and a verified refresh; reset stays generic", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page);
  await page.goto("/");
  await page.getByRole("button", { name: "建立新帳號", exact: true }).click();
  await fillEmail(page, "person@example.invalid", "synthetic-password");
  fixture.duplicate(true);
  await page.getByRole("button", { name: "建立帳號", exact: true }).click();
  await expect(
    page
      .getByText("此信箱已有帳號，請登入原帳號；若忘記密碼，可寄送重設信。", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  fixture.duplicate(false);
  fixture.failVerification(true);
  await page.getByRole("button", { name: "建立帳號", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/帳號已建立，但驗證信尚未寄出/)).toBeVisible();
  await page.goto("/#profile");
  fixture.failVerification(false);
  await page
    .getByRole("button", { name: "驗證信箱／更新驗證狀態", exact: true })
    .click();
  await expect
    .poll(() => fixture.oob.filter((item) => item === "VERIFY_EMAIL").length)
    .toBe(2);
  fixture.verified(true);
  await page
    .getByRole("button", { name: "驗證信箱／更新驗證狀態", exact: true })
    .click();
  await expect(page.getByText(/請開啟信箱中的驗證信/)).toHaveCount(0);
  expect(fixture.oob.filter((item) => item === "VERIFY_EMAIL")).toHaveLength(2);
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("button", { name: "忘記密碼？", exact: true }).click();
  await fillEmail(page);
  await page.getByRole("button", { name: "寄送重設信", exact: true }).click();
  await expect(
    page.getByText("若此信箱可重設密碼，你將收到操作信件。", { exact: true }),
  ).toBeVisible();
  expect(fixture.oob).toContain("PASSWORD_RESET");
  expect(
    fixture.continueUrls.filter((url) => url.endsWith("/#profile")),
  ).toHaveLength(2);
  expect(fixture.continueUrls.at(-1)).toBe(new URL("/#home", page.url()).href);
  await page.getByRole("button", { name: "返回登入", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "登入", exact: true }),
  ).toBeVisible();
});

test("logout immediately stops speech and clears chat while device cleanup is pending, without affecting the next session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("yzt-device-id", "synthetic-device");
    const probe = { speaking: false, cancellations: 0 };
    Object.assign(window, { syntheticSpeechProbe: probe });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        speak: () => {
          probe.speaking = true;
        },
        cancel: () => {
          probe.speaking = false;
          probe.cancellations++;
        },
      },
    });
  });
  const fixture = await syntheticAuth(page);
  const releaseCleanup = fixture.holdDeviceDeletion();
  try {
    await page.goto("/#chat");
    await fillEmail(page);
    await page.getByRole("button", { name: "登入", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "用藥問答", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "用藥問題", exact: true })
      .fill("合成舊帳號健康草稿");
    await page.evaluate(() =>
      speechSynthesis.speak(new SpeechSynthesisUtterance("合成舊帳號朗讀")),
    );
    await page.getByRole("button", { name: "登出", exact: true }).click();
    // These are immediate logout effects, independent of Firebase's null-user
    // callback and of the intentionally held device DELETE response.
    expect(
      await page.evaluate(() => ({
        hash: location.hash,
        ...(window as any).syntheticSpeechProbe,
      })),
    ).toEqual({ hash: "#home", speaking: false, cancellations: 1 });
    await expect(
      page.getByRole("heading", { name: "用藥問答", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "登入", exact: true }),
    ).toBeVisible();
    await expect.poll(() => fixture.deviceDeletes.length).toBe(1);
    expect(fixture.deviceDeletes[0]).toMatch(/^Bearer /);
    expect(
      await page.evaluate(() => sessionStorage.getItem("yzt-device-id")),
    ).toBeNull();

    await fillEmail(page, "other@example.invalid");
    await page.getByRole("button", { name: "登入", exact: true }).click();
    await expect(page.locator(".user-name")).toHaveText("synthetic-other-user");
    await page.goto("/#chat");
    await expect(
      page.getByRole("textbox", { name: "用藥問題", exact: true }),
    ).toHaveValue("");
    await page.evaluate(() =>
      speechSynthesis.speak(new SpeechSynthesisUtterance("合成新帳號朗讀")),
    );
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        new URL(r.url()).pathname.includes("/devices/"),
    );
    releaseCleanup();
    await response;
    await expect(
      page.getByRole("heading", { name: "用藥問答", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        hash: location.hash,
        ...(window as any).syntheticSpeechProbe,
      })),
    ).toEqual({ hash: "#chat", speaking: true, cancellations: 1 });
  } finally {
    releaseCleanup();
  }
});

test("a restored email session can recover from a temporary /me failure", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page);
  await page.goto("/");
  await fillEmail(page);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
  fixture.failMe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重試連線並恢復登入", exact: true }),
  ).toBeVisible();
  fixture.failMe(false);
  await page
    .getByRole("button", { name: "重試連線並恢復登入", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
});

test("refresh during Google profile verification quarantines the incomplete session and permits email recovery", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page);
  fixture.holdGoogle();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Google 合成測試登入", exact: true })
    .click();
  await expect.poll(() => fixture.profileReads()).toBe(1);
  await page.reload();
  fixture.releaseGoogle();
  await expect(page.getByText(/上次 Google 登入未完成/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "登出", exact: true }),
  ).toHaveCount(0);
  await fillEmail(page);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
});

test("a fully verified Google session survives refresh and is removed by logout", async ({
  page,
}) => {
  const fixture = await syntheticAuth(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Google 合成測試登入", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
  expect(fixture.profileReads()).toBe(1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
  expect(fixture.profileReads()).toBe(1);
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "登入", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).some((key) =>
        key.startsWith("yzt-google-session:"),
      ),
    ),
  ).toBe(false);
});

test("blocked sessionStorage falls back to a usable memory-only email session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Synthetic storage blocked", "SecurityError");
      },
    });
  });
  await syntheticAuth(page);
  await page.goto("/");
  await fillEmail(page);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今天的用藥日常", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "登入", exact: true }),
  ).toBeVisible();
});


test("public registration explains verified access and current daily limits", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 757 });
  await syntheticAuth(page, "verified");
  await page.goto("/"); await page.getByRole("button", { name: "建立新帳號", exact: true }).click();
  await expect(page.getByText("建立帳號並驗證信箱，即可開始使用。", { exact: true })).toBeVisible();
  await expect(page.locator("#registration-trial-notice")).toContainText("AI 每人每日 20 次，全站每日 1000 次");
  await expect(page.locator("#registration-trial-notice")).not.toContainText("另行取得");
  await expectPrimaryInFirstScreen(page, "建立帳號");
});
