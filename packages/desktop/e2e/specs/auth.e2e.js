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

    // 2. Click login → auth modal opens
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

    // 5. Submit registration → modal closes, user name appears in sidebar
    const submitBtn = await $("button.auth-submit");
    await submitBtn.click();

    // Verify modal is gone first
    const overlay = await $(".auth-overlay");
    await overlay.waitForDisplayed({ reverse: true, timeout: 5000 });

    // Open sidebar to check user name
    await menuBtn.click();
    const userName = await $(".sidebar-user-name");
    await userName.waitForDisplayed({ timeout: 10000 });
    await expect(userName).toHaveText(TEST_NAME);

    // 6. Logout (sidebar already open from step 5) → login button reappears
    const logoutBtn = await $(".sidebar-logout-btn");
    await logoutBtn.waitForDisplayed({ timeout: 5000 });
    await logoutBtn.click();
    await loginBtn.waitForDisplayed({ timeout: 5000 });

    // 7. Log back in with same credentials
    await loginBtn.click();
    await title.waitForDisplayed();
    await expect(title).toHaveText("Log in");

    await emailInput.setValue(TEST_EMAIL);
    await passwordInput.setValue(TEST_PASSWORD);
    await submitBtn.click();

    // 8. Open sidebar, verify user is logged in again
    await menuBtn.click();
    await userName.waitForDisplayed({ timeout: 10000 });
    await expect(userName).toHaveText(TEST_NAME);
  });
});
