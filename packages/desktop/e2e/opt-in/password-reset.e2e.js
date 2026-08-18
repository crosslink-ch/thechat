const enabled = process.env.PASSWORD_RESET_E2E === "1";
const describePasswordReset = enabled ? describe : describe.skip;

function loopbackHttpOrigin(name, rawValue) {
  if (!rawValue) throw new Error(`${name} is required`);
  const parsed = new URL(rawValue);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an explicit loopback HTTP origin`);
  }
  return parsed.origin;
}

if (enabled && process.env.THECHAT_E2E_LOOPBACK_ONLY !== "1") {
  throw new Error("Password-reset E2E requires loopback-only mode");
}

const API_URL = enabled
  ? loopbackHttpOrigin(
      "PASSWORD_RESET_E2E_API_URL",
      process.env.PASSWORD_RESET_E2E_API_URL,
    )
  : "http://127.0.0.1:3000";
const MAILPIT_API_URL = enabled
  ? loopbackHttpOrigin(
      "PASSWORD_RESET_E2E_MAILPIT_URL",
      process.env.PASSWORD_RESET_E2E_MAILPIT_URL,
    )
  : "http://127.0.0.1:8025";

async function jsonFetch(pathname, options = {}) {
  const response = await fetch(`${API_URL}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function waitForResetCode(email) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const listResponse = await fetch(`${MAILPIT_API_URL}/api/v1/messages`);
    if (!listResponse.ok) {
      throw new Error(`Mailpit list failed (${listResponse.status})`);
    }
    const list = await listResponse.json();
    const message = list.messages?.find(
      (entry) =>
        entry.Subject === "Your TheChat password reset code" &&
        entry.To?.some(
          (recipient) => recipient.Address?.toLowerCase() === email.toLowerCase(),
        ),
    );
    if (message) {
      const messageResponse = await fetch(
        `${MAILPIT_API_URL}/api/v1/message/${message.ID}`,
      );
      if (!messageResponse.ok) {
        throw new Error(`Mailpit message failed (${messageResponse.status})`);
      }
      const detail = await messageResponse.json();
      const code = `${detail.Text ?? ""}\n${detail.HTML ?? ""}`.match(
        /\b\d{6}\b/,
      )?.[0];
      if (!code) throw new Error("Reset message did not contain a 6-digit code");
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No password reset email arrived in Mailpit for ${email}`);
}

describePasswordReset("password reset", () => {
  it("resets through the compiled Tauri UI and a captured SMTP email", async function () {
    this.timeout(180_000);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = `password-reset-e2e-${suffix}@example.invalid`;
    const oldPassword = "old-password-123";
    const newPassword = "new-password-456";

    const registered = await jsonFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Password Reset E2E",
        email,
        password: oldPassword,
      }),
    });
    expect(registered.response.status).toBe(200);
    expect(registered.body.accessToken).toBeTruthy();
    const oldToken = registered.body.accessToken;

    const emailInput = await $("#auth-email");
    await emailInput.waitForExist({ timeout: 30_000 });
    const submitButton = await $("form button[type='submit']");
    if ((await submitButton.getText()) !== "Log in") {
      await $("button=Log in").click();
      await browser.waitUntil(
        async () => (await submitButton.getText()) === "Log in",
        { timeout: 5_000, timeoutMsg: "Auth panel did not switch to login" },
      );
    }

    await emailInput.setValue(email);
    await $("button=Forgot password?").click();
    const resetEmail = await $("#reset-email");
    await resetEmail.waitForExist({ timeout: 5_000 });
    expect(await resetEmail.getValue()).toBe(email);
    await $("button=Send reset code").click();

    const resetCode = await $("#reset-code");
    await resetCode.waitForExist({ timeout: 10_000 });
    if (process.env.PASSWORD_RESET_E2E_SCREENSHOT) {
      await browser.saveScreenshot(process.env.PASSWORD_RESET_E2E_SCREENSHOT);
    }
    const code = await waitForResetCode(email);
    await resetCode.setValue(code);
    await $("#reset-password").setValue(newPassword);
    await $("#reset-password-confirmation").setValue(newPassword);
    await $("button=Reset password").click();

    await browser.waitUntil(
      async () => (await $("h2").getText()) === "Log in",
      { timeout: 10_000, timeoutMsg: "Reset did not return to login" },
    );
    expect(await $("div[role='status']").getText()).toContain("Password reset");

    const revoked = await jsonFetch("/auth/me", {
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(revoked.response.status).toBe(401);
    expect(
      (
        await jsonFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password: oldPassword }),
        })
      ).response.status,
    ).toBe(401);

    await $("#auth-password").setValue(newPassword);
    await $("form button[type='submit']").click();
    await emailInput.waitForExist({ reverse: true, timeout: 15_000 });

    expect(
      (
        await jsonFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password: newPassword }),
        })
      ).response.status,
    ).toBe(200);
  });
});
