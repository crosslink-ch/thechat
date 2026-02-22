const TEST_NAME = "E2E Test User";
const TEST_EMAIL = `e2e-${Date.now()}@test.local`;
const TEST_PASSWORD = "TestPass123!";

describe("Auth flow", () => {
  it("should register, logout, and log back in", async () => {
    // 1. Wait for app to load, open sidebar, login button should be visible
    const menuBtn = await $(".menu-btn");
    await menuBtn.waitForDisplayed({ timeout: 15000 });
    await menuBtn.click();

    const loginBtn = await $(".sidebar-login-btn");
    await loginBtn.waitForDisplayed({ timeout: 5000 });

    // 2. Click login → auth modal opens (sidebar stays open behind it)
    await loginBtn.click();
    const title = await $("h2.auth-title");
    await title.waitForDisplayed();
    await expect(title).toHaveText("Log in");

    // 3. Switch to register mode
    const switchBtn = await $(".auth-switch button");
    await switchBtn.click();
    await expect(title).toHaveText("Create account");

    // 4. Fill registration form
    const nameInput = await $("#auth-name");
    const emailInput = await $("#auth-email");
    const passwordInput = await $("#auth-password");

    await nameInput.setValue(TEST_NAME);
    await emailInput.setValue(TEST_EMAIL);
    await passwordInput.setValue(TEST_PASSWORD);

    // 5. Submit registration → modal closes, sidebar is still open
    const submitBtn = await $("button.auth-submit");
    await submitBtn.click();

    await browser.waitUntil(
      async () => !(await $(".auth-overlay").isExisting()),
      { timeout: 10000, timeoutMsg: "Auth modal did not close after registration" },
    );

    // Sidebar was already open — wait for user name to populate
    await browser.waitUntil(
      async () => (await $(".sidebar-user-name").getText()) === TEST_NAME,
      { timeout: 10000, timeoutMsg: `Expected sidebar to show "${TEST_NAME}"` },
    );

    // 6. Logout → login button reappears (sidebar still open)
    const logoutBtn = await $(".sidebar-logout-btn");
    await logoutBtn.waitForDisplayed({ timeout: 5000 });
    await logoutBtn.click();
    await loginBtn.waitForDisplayed({ timeout: 5000 });

    // 7. Log back in with same credentials (sidebar still open)
    await loginBtn.click();
    await title.waitForDisplayed();
    await expect(title).toHaveText("Log in");

    await emailInput.setValue(TEST_EMAIL);
    await passwordInput.setValue(TEST_PASSWORD);
    await submitBtn.click();

    await browser.waitUntil(
      async () => !(await $(".auth-overlay").isExisting()),
      { timeout: 10000, timeoutMsg: "Auth modal did not close after login" },
    );

    // 8. Sidebar still open — wait for user name to populate again
    await browser.waitUntil(
      async () => (await $(".sidebar-user-name").getText()) === TEST_NAME,
      { timeout: 10000, timeoutMsg: `Expected sidebar to show "${TEST_NAME}" after login` },
    );
  });
});
