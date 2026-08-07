import fs from "node:fs";
import path from "node:path";

const enabled = process.env.HERMES_APPROVAL_E2E === "1";
const describeApproval = enabled ? describe : describe.skip;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function requiredStringArray(name) {
  const parsed = JSON.parse(required(name));
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`${name} must be a non-empty JSON string array`);
  }
  return parsed;
}

async function bodyText() {
  return await $("body").getText();
}

function containsTypedApprovalFallback(text) {
  return text.includes("Reply /approve") ||
    (text.includes("Dangerous command requires approval") &&
      text.includes("/approve"));
}

describeApproval("real Hermes approval UI", () => {
  it("renders and resolves the structured command approval card", async function () {
    this.timeout(240_000);

    const email = required("HERMES_APPROVAL_E2E_EMAIL");
    const password = required("HERMES_APPROVAL_E2E_PASSWORD");
    const botName = required("HERMES_APPROVAL_E2E_BOT_NAME");
    const conversationId = required("HERMES_APPROVAL_E2E_CONVERSATION_ID");
    const trigger = required("HERMES_APPROVAL_E2E_TRIGGER_MESSAGE");
    const command = required("HERMES_APPROVAL_E2E_COMMAND");
    const reason = required("HERMES_APPROVAL_E2E_REASON");
    const clarifyQuestion = required("HERMES_APPROVAL_E2E_CLARIFY_QUESTION");
    const clarifyChoices = requiredStringArray(
      "HERMES_APPROVAL_E2E_CLARIFY_CHOICES",
    );
    const clarifyResponse = requiredStringArray(
      "HERMES_APPROVAL_E2E_CLARIFY_RESPONSE",
    );
    const finalMessage = required("HERMES_APPROVAL_E2E_FINAL_MESSAGE");
    const screenshotPath = required("HERMES_APPROVAL_E2E_SCREENSHOT");

    try {
      const emailInput = await $("#auth-email");
      await emailInput.waitForDisplayed({ timeout: 30_000 });
      const submitButton = await $("form button[type='submit']");
      if ((await submitButton.getText()) !== "Log in") {
        await $("button=Log in").click();
        await browser.waitUntil(
          async () => (await submitButton.getText()) === "Log in",
          { timeout: 5_000, timeoutMsg: "Auth panel did not switch to login" },
        );
      }
      await emailInput.setValue(email);
      await $("#auth-password").setValue(password);
      await submitButton.click();
      await emailInput.waitForExist({ reverse: true, timeout: 30_000 });

      await browser.execute((targetConversationId) => {
        window.location.hash = `#/dm/${targetConversationId}`;
      }, conversationId);

      const chatSurface = await $("[data-testid='hermes-dm-chat-scroll']");
      await chatSurface.waitForDisplayed({ timeout: 30_000 });

      const botLabel = await $(`//*[normalize-space(text())='${botName}']`);
      await botLabel.waitForDisplayed({ timeout: 30_000 });

      const composer = await $("div[contenteditable='true']");
      await composer.waitForDisplayed({ timeout: 30_000 });
      await composer.click();
      await browser.execute((message) => {
        document.execCommand("insertText", false, message);
      }, trigger);
      await browser.keys("Enter");

      const approvalCard = await $("[data-testid='hermes-approval-request']");
      await browser.waitUntil(
        async () =>
          (await approvalCard.isExisting()) ||
          containsTypedApprovalFallback(await bodyText()),
        {
          timeout: 120_000,
          interval: 250,
          timeoutMsg: "Hermes produced neither an approval card nor a fallback",
        },
      );

      const pendingBodyText = await bodyText();
      expect(containsTypedApprovalFallback(pendingBodyText)).toBe(false);
      await approvalCard.waitForDisplayed({ timeout: 5_000 });

      const cardText = await approvalCard.getText();
      expect(cardText).toContain(`${botName} wants to run a command`);
      expect(cardText).toContain(command);
      expect(cardText).toContain(reason);
      expect(cardText).toContain("Approve");
      expect(cardText).toContain("Approve for session");
      expect(cardText).toContain("Deny");

      const absoluteScreenshotPath = path.resolve(screenshotPath);
      fs.mkdirSync(path.dirname(absoluteScreenshotPath), { recursive: true });
      await browser.saveScreenshot(absoluteScreenshotPath);

      const approveButton = await approvalCard.$(
        ".//button[normalize-space(.)='Approve']",
      );
      await approveButton.waitForClickable({ timeout: 10_000 });
      await approveButton.click();

      const confirmedResolution = await $(
        '[data-testid="hermes-approval-resolved"][data-confirmed="true"]',
      );
      await confirmedResolution.waitForDisplayed({ timeout: 30_000 });
      expect(await confirmedResolution.getText()).toContain("Approved");

      const clarifyCard = await $("[data-testid='hermes-clarify-request']");
      await clarifyCard.waitForDisplayed({ timeout: 120_000 });
      const clarifyText = await clarifyCard.getText();
      expect(clarifyText).toContain(`${botName} needs your input`);
      expect(clarifyText).toContain(clarifyQuestion);
      for (const choice of clarifyChoices) {
        expect(clarifyText).toContain(choice);
      }
      const clarifyScreenshotPath = path.resolve(
        path.dirname(screenshotPath),
        "hermes-clarify-ui-e2e.png",
      );
      await browser.saveScreenshot(clarifyScreenshotPath);

      for (const choice of clarifyResponse) {
        const checkbox = await clarifyCard.$(
          `.//label[.//span[normalize-space(.)="${choice}"]]//input[@type="checkbox"]`,
        );
        await checkbox.waitForClickable({ timeout: 10_000 });
        await checkbox.click();
        expect(await checkbox.isSelected()).toBe(true);
      }
      const submitClarify = await clarifyCard.$(
        ".//button[normalize-space(.)='Submit selected']",
      );
      await submitClarify.waitForClickable({ timeout: 10_000 });
      await submitClarify.click();

      // A confirmed row can only arrive after the API's signed interaction
      // envelope was accepted by the real Hermes webhook adapter.
      const confirmedClarify = await $(
        '[data-testid="hermes-clarify-resolved"][data-confirmed="true"]',
      );
      await confirmedClarify.waitForDisplayed({ timeout: 30_000 });

      const finalReply = await $(`//*[normalize-space(text())='${finalMessage}']`);
      await finalReply.waitForDisplayed({ timeout: 120_000 });
      await approvalCard.waitForExist({ reverse: true, timeout: 30_000 });
      await clarifyCard.waitForExist({ reverse: true, timeout: 30_000 });
      expect(containsTypedApprovalFallback(await bodyText())).toBe(false);
    } catch (error) {
      const failurePath = path.resolve(
        path.dirname(screenshotPath),
        "hermes-approval-ui-e2e-failure.png",
      );
      try {
        await browser.saveScreenshot(failurePath);
      } catch {
        // Preserve the original browser failure.
      }
      throw error;
    }
  });
});
