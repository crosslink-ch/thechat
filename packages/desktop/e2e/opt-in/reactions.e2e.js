import fs from "node:fs";
import path from "node:path";

const enabled = process.env.REACTIONS_E2E === "1";
const describeReactions = enabled ? describe : describe.skip;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const API_URL = enabled ? required("THECHAT_BACKEND_URL") : "http://127.0.0.1:3000";
const EMAIL = enabled ? required("REACTIONS_E2E_EMAIL") : "";
const PASSWORD = enabled ? required("REACTIONS_E2E_PASSWORD") : "";
const CONVERSATION_ID = enabled ? required("REACTIONS_E2E_CONVERSATION_ID") : "";
const WORKSPACE_NAME = enabled ? required("REACTIONS_E2E_WORKSPACE_NAME") : "";
const MESSAGE_ID = enabled ? required("REACTIONS_E2E_MESSAGE_ID") : "";
const PICKER_SCREENSHOT = enabled ? required("REACTIONS_E2E_PICKER_SCREENSHOT") : "";
const APPLIED_SCREENSHOT = enabled ? required("REACTIONS_E2E_APPLIED_SCREENSHOT") : "";
const REMOVED_SCREENSHOT = enabled ? required("REACTIONS_E2E_REMOVED_SCREENSHOT") : "";
const FAILURE_SCREENSHOT = enabled ? required("REACTIONS_E2E_FAILURE_SCREENSHOT") : "";
const EVIDENCE = enabled ? required("REACTIONS_E2E_EVIDENCE") : "";

describeReactions("Message reactions", function () {
  this.timeout(240_000);

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      fs.mkdirSync(path.dirname(FAILURE_SCREENSHOT), { recursive: true });
      await browser.saveScreenshot(FAILURE_SCREENSHOT);
    }
  });

  it("renders bundled emoji and removes reactions optimistically in the compiled Tauri app", async () => {
    await browser.setWindowSize(1180, 760);

    const loginResponse = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json();
    expect(login.user?.name).toBeTruthy();
    const resetResponse = await fetch(
      `${API_URL}/messages/${CONVERSATION_ID}/${MESSAGE_ID}/reactions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${login.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ emoji: "🎉", active: false }),
      },
    );
    expect(resetResponse.status).toBe(200);

    const emailInput = await $("#auth-email");
    await emailInput.waitForExist({ timeout: 30_000 });
    const submitButton = await $("form button[type='submit']");
    if ((await submitButton.getText()) !== "Log in") {
      await $("button=Log in").click();
      await browser.waitUntil(async () => (await submitButton.getText()) === "Log in", {
        timeout: 5_000,
        timeoutMsg: "Auth panel did not switch to login",
      });
    }
    await emailInput.setValue(EMAIL);
    await $("#auth-password").setValue(PASSWORD);
    await submitButton.click();
    await emailInput.waitForExist({ reverse: true, timeout: 30_000 });

    const channelButton = await $(`[data-channel-id="${CONVERSATION_ID}"]`);
    const workspaceAutoSelected = await channelButton
      .waitForExist({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!workspaceAutoSelected) {
      const workspaceSelector = await $("button=Select workspace");
      await workspaceSelector.waitForClickable({ timeout: 15_000 });
      await workspaceSelector.click();
      const workspaceButton = await $(`button=${WORKSPACE_NAME}`);
      await workspaceButton.waitForClickable({ timeout: 10_000 });
      await workspaceButton.click();
    }
    await channelButton.waitForClickable({ timeout: 15_000 });
    await channelButton.click();

    const row = await $(`[data-message-id="${MESSAGE_ID}"]`);
    await row.waitForExist({ timeout: 30_000 });
    await row.scrollIntoView();
    const addReaction = await row.$('button[aria-label="Add reaction"]');
    await addReaction.moveTo();
    await addReaction.click();

    const picker = await $('[role="menu"]');
    await picker.waitForDisplayed({ timeout: 10_000 });
    expect(await picker.getAttribute("aria-labelledby")).toBeTruthy();
    const pickerChoice = await $('button[aria-label="React with 🎉"]');
    const pickerImage = await pickerChoice.$("[data-emoji-image]");
    await pickerImage.waitForDisplayed({ timeout: 10_000 });
    const pickerSprite = await browser.execute(
      (element) => getComputedStyle(element).backgroundImage,
      pickerImage,
    );
    expect(pickerSprite).not.toBe("none");
    fs.mkdirSync(path.dirname(PICKER_SCREENSHOT), { recursive: true });
    await browser.saveScreenshot(PICKER_SCREENSHOT);

    await pickerChoice.click();
    await picker.waitForDisplayed({ reverse: true, timeout: 10_000 });
    const reaction = await row.$('button[aria-label^="🎉 "]');
    await reaction.waitForDisplayed({ timeout: 15_000 });
    const reactionText = await reaction.getText();
    expect(reactionText).not.toContain("🎉");
    expect(await reaction.getAttribute("aria-pressed")).toBe("true");
    const reactionImage = await reaction.$("[data-emoji-image]");
    await reactionImage.waitForDisplayed({ timeout: 10_000 });
    const reactionSprite = await browser.execute(
      (element) => getComputedStyle(element).backgroundImage,
      reactionImage,
    );
    expect(reactionSprite).not.toBe("none");
    await browser.saveScreenshot(APPLIED_SCREENSHOT);

    const response = await fetch(`${API_URL}/messages/${CONVERSATION_ID}`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    const persisted = payload.find((message) => message.id === MESSAGE_ID);
    expect(persisted).toBeTruthy();
    const persistedReaction = persisted.reactions.find(
      (candidate) => candidate.emoji === "🎉",
    );
    expect(persistedReaction).toBeTruthy();
    expect(persistedReaction.count).toBeGreaterThan(0);
    expect(persistedReaction.reactedByMe).toBe(true);
    expect(persistedReaction.userNames).toContain(login.user.name);
    expect(reactionText).toContain(String(persistedReaction.count));

    const reactionPath = `/messages/${CONVERSATION_ID}/${MESSAGE_ID}/reactions`;
    await browser.execute((pathToDelay) => {
      const originalFetch = window.fetch.bind(window);
      window.__thechatReactionFetch = {
        started: false,
        finished: false,
        release: null,
        originalFetch,
      };
      window.fetch = async (...args) => {
        const input = args[0];
        const init = args[1];
        const url = typeof input === "string" ? input : input.url;
        const method = (init?.method ?? (typeof input === "string" ? "GET" : input.method)).toUpperCase();
        if (method === "POST" && url.includes(pathToDelay)) {
          window.__thechatReactionFetch.started = true;
          await new Promise((resolve) => {
            window.__thechatReactionFetch.release = resolve;
          });
        }
        const result = await originalFetch(...args);
        window.__thechatReactionFetch.finished = true;
        return result;
      };
    }, reactionPath);

    const countBeforeRemoval = Number.parseInt(reactionText.trim(), 10);
    expect(countBeforeRemoval).toBeGreaterThan(0);
    const removalStartedAt = Date.now();
    await reaction.click();
    await browser.waitUntil(
      () => browser.execute(() => window.__thechatReactionFetch?.started === true),
      {
        timeout: 5_000,
        timeoutMsg: "Delayed reaction removal request did not start",
      },
    );

    if (countBeforeRemoval === 1) {
      await reaction.waitForExist({ reverse: true, timeout: 1_000 });
    } else {
      const remaining = countBeforeRemoval - 1;
      const suffix = remaining === 1 ? "reaction" : "reactions";
      const optimisticReaction = await row.$(
        `button[aria-label="🎉 ${remaining} ${suffix}"]`,
      );
      await optimisticReaction.waitForDisplayed({ timeout: 1_000 });
      expect(await optimisticReaction.getAttribute("aria-pressed")).toBe("false");
    }
    const optimisticRemovalElapsedMs = Date.now() - removalStartedAt;
    await browser.saveScreenshot(REMOVED_SCREENSHOT);

    await browser.execute(() => {
      window.__thechatReactionFetch.release();
    });
    await browser.waitUntil(
      () => browser.execute(() => window.__thechatReactionFetch?.finished === true),
      {
        timeout: 15_000,
        timeoutMsg: "Delayed reaction removal request did not finish",
      },
    );
    await browser.execute(() => {
      window.fetch = window.__thechatReactionFetch.originalFetch;
      delete window.__thechatReactionFetch;
    });

    const removedResponse = await fetch(`${API_URL}/messages/${CONVERSATION_ID}`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    expect(removedResponse.status).toBe(200);
    const removedPayload = await removedResponse.json();
    const removedMessage = removedPayload.find(
      (message) => message.id === MESSAGE_ID,
    );
    const persistedAfterRemoval = removedMessage.reactions.find(
      (candidate) => candidate.emoji === "🎉",
    );
    expect(persistedAfterRemoval?.reactedByMe ?? false).toBe(false);

    fs.writeFileSync(
      EVIDENCE,
      JSON.stringify(
        {
          messageId: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          pickerVisible: true,
          imageBacked: true,
          pickerSprite,
          reactionSprite,
          reactionText,
          persistedReaction,
          optimisticRemovalVerified: true,
          optimisticRemovalElapsedMs,
          persistedAfterRemoval: persistedAfterRemoval ?? null,
          screenshots: [
            PICKER_SCREENSHOT,
            APPLIED_SCREENSHOT,
            REMOVED_SCREENSHOT,
          ],
        },
        null,
        2,
      ),
    );
  });
});
