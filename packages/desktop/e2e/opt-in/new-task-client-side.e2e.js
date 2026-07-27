import fs from "node:fs";
import path from "node:path";

const enabled = process.env.NEW_TASK_CLIENT_SIDE_E2E === "1";
const describeNewTask = enabled ? describe : describe.skip;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function waitForJson(filePath, label) {
  await browser.waitUntil(
    async () => fs.existsSync(filePath) && fs.statSync(filePath).size > 0,
    {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: `Timed out waiting for ${label}: ${filePath}`,
    },
  );
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describeNewTask("client-only Hermes New task", () => {
  it("opens a local draft while the API and database are offline", async function () {
    this.timeout(240_000);

    const email = required("NEW_TASK_CLIENT_SIDE_E2E_EMAIL");
    const password = required("NEW_TASK_CLIENT_SIDE_E2E_PASSWORD");
    const botName = required("NEW_TASK_CLIENT_SIDE_E2E_BOT_NAME");
    const conversationId = required("NEW_TASK_CLIENT_SIDE_E2E_CONVERSATION_ID");
    const controlDir = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_CONTROL_DIR"));
    const screenshotPath = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_SCREENSHOT"));
    const evidencePath = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_EVIDENCE"));
    const offlineRequest = path.join(controlDir, "offline.request");
    const offlineEvidencePath = path.join(controlDir, "offline.json");
    const verifyRequest = path.join(controlDir, "verify-database.request");
    const databaseEvidencePath = path.join(controlDir, "database.json");

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
      await $(`//*[normalize-space(text())='${botName}']`).waitForDisplayed({ timeout: 30_000 });
      const newTaskButton = await $("button[aria-label='New task']");
      await newTaskButton.waitForClickable({ timeout: 30_000 });
      const composer = await $("div[contenteditable='true']");
      await composer.waitForDisplayed({ timeout: 30_000 });
      expect(await $("[data-testid='hermes-local-task-draft']").isExisting()).toBe(false);

      await browser.execute(() => {
        const records = { fetches: [], websocketSends: [] };
        const originalFetch = window.fetch.bind(window);
        window.fetch = (...args) => {
          const input = args[0];
          const init = args[1];
          records.fetches.push({
            url: typeof input === "string" ? input : input.url,
            method: init?.method ?? (typeof input === "string" ? "GET" : input.method),
          });
          return originalFetch(...args);
        };
        const originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          records.websocketSends.push(typeof data === "string" ? data : "<binary>");
          return originalSend.call(this, data);
        };
        window.__newTaskNetworkRecords = records;
      });

      fs.writeFileSync(offlineRequest, "offline\n", { flag: "wx" });
      const offline = await waitForJson(offlineEvidencePath, "offline backend evidence");
      expect(offline.apiReachable).toBe(false);
      expect(offline.postgresReachable).toBe(false);
      expect(offline.redisReachable).toBe(false);
      expect(offline.postgresRunning).toBe(false);
      expect(offline.threadCountBefore).toBe(0);

      await browser.execute(() => {
        window.__newTaskNetworkRecords.fetches.length = 0;
        window.__newTaskNetworkRecords.websocketSends.length = 0;
      });

      await newTaskButton.click();

      const draftRow = await $("[data-testid='hermes-local-task-draft']");
      await draftRow.waitForDisplayed({ timeout: 5_000 });
      expect(await draftRow.getAttribute("aria-current")).toBe("true");
      expect(await draftRow.getText()).toContain("Draft, not saved");
      expect(await composer.isDisplayed()).toBe(true);
      expect(await composer.getText()).toBe("");

      await browser.pause(1_000);
      const network = await browser.execute(() => ({
        fetches: [...window.__newTaskNetworkRecords.fetches],
        websocketSends: [...window.__newTaskNetworkRecords.websocketSends],
      }));
      expect(network.fetches).toEqual([]);
      expect(network.websocketSends).toEqual([]);

      fs.writeFileSync(verifyRequest, "verify\n", { flag: "wx" });
      const database = await waitForJson(databaseEvidencePath, "database side-effect evidence");
      expect(database.threadCountAfter).toBe(offline.threadCountBefore);
      expect(database.apiReachable).toBe(false);

      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await browser.saveScreenshot(screenshotPath);
      fs.writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            ok: true,
            conversationId,
            draftVisible: true,
            composerEmpty: true,
            network,
            offline,
            database,
            screenshot: screenshotPath,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const failurePath = path.resolve(path.dirname(screenshotPath), "new-task-client-side-failure.png");
      try {
        await browser.saveScreenshot(failurePath);
      } catch {
        // Preserve the original browser failure.
      }
      throw error;
    }
  });
});
