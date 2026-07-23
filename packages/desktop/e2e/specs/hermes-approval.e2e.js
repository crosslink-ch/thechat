const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the Hermes approval E2E`);
  return value;
};

const email = required("HERMES_APPROVAL_E2E_EMAIL");
const password = required("HERMES_APPROVAL_E2E_PASSWORD");
const botName = required("HERMES_APPROVAL_E2E_BOT_NAME");
const conversationId = required("HERMES_APPROVAL_E2E_CONVERSATION_ID");
const triggerMessage = required("HERMES_APPROVAL_E2E_TRIGGER_MESSAGE");
const approvalCommand = required("HERMES_APPROVAL_E2E_COMMAND");
const finalMessage = required("HERMES_APPROVAL_E2E_FINAL_MESSAGE");
const screenshotPath = required("HERMES_APPROVAL_E2E_SCREENSHOT");

async function bodyText() {
  return $("body").getText();
}

describe("real Hermes approval flow", () => {
  it("renders and resolves a structured approval card without typed /approve", async function () {
    this.timeout(240_000);
    const loginModeButton = await $("//button[normalize-space(.)='Log in']");
    await loginModeButton.waitForClickable({ timeout: 30_000 });
    await loginModeButton.click();

    await $("#auth-email").setValue(email);
    await $("#auth-password").setValue(password);
    const loginSubmit = await $("//form//button[@type='submit' and normalize-space(.)='Log in']");
    await loginSubmit.click();

    try {
      await $("#auth-email").waitForExist({ reverse: true, timeout: 30_000 });
    } catch (error) {
      await browser.saveScreenshot(screenshotPath.replace(/\.png$/, "-login-failure.png"));
      throw new Error(`desktop login did not complete; body: ${await bodyText()}`, {
        cause: error,
      });
    }

    await browser.execute((id) => {
      window.location.hash = `#/dm/${id}`;
    }, conversationId);

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes(`/dm/${conversationId}`),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: `Hermes DM route ${conversationId} did not load`,
      },
    );

    const botLabel = await $(`//*[normalize-space(text())='${botName}']`);
    await botLabel.waitForExist({ timeout: 30_000 });

    const editor = await $("[contenteditable='true']");
    await editor.waitForDisplayed({ timeout: 30_000 });
    await editor.click();
    await browser.keys(triggerMessage);
    await browser.keys("Enter");

    const approvalCard = await $("[data-testid='hermes-approval-request']");
    await approvalCard.waitForDisplayed({ timeout: 120_000 });

    await browser.saveScreenshot(screenshotPath);

    const cardText = await approvalCard.getText();
    expect(cardText).toContain(`${botName} wants to run a command`);
    expect(cardText).toContain(approvalCommand);
    expect(cardText).toContain("Security scan");
    expect(cardText).toContain("Approve for session");
    expect(cardText).toContain("Deny");
    expect(await bodyText()).not.toContain("Reply /approve");

    const approveButton = await $("//button[normalize-space(.)='Approve']");
    await approveButton.waitForClickable({ timeout: 10_000 });
    await approveButton.click();

    await approvalCard.waitForExist({ reverse: true, timeout: 30_000 });
    await browser.waitUntil(
      async () => (await bodyText()).includes(finalMessage),
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: "Hermes did not continue after the UI approval decision",
      },
    );
    expect(await bodyText()).not.toContain("Reply /approve");
  });
});
