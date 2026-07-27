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
  it("opens an API-free local draft from an existing task with stale General history", async function () {
    this.timeout(240_000);

    const email = required("NEW_TASK_CLIENT_SIDE_E2E_EMAIL");
    const password = required("NEW_TASK_CLIENT_SIDE_E2E_PASSWORD");
    const botName = required("NEW_TASK_CLIENT_SIDE_E2E_BOT_NAME");
    const conversationId = required("NEW_TASK_CLIENT_SIDE_E2E_CONVERSATION_ID");
    const existingThreadTitle = required("NEW_TASK_CLIENT_SIDE_E2E_EXISTING_THREAD_TITLE");
    const generalCacheWitness = required("NEW_TASK_CLIENT_SIDE_E2E_GENERAL_CACHE_WITNESS");
    const staleGeneralWaitMs = Number(
      process.env.NEW_TASK_CLIENT_SIDE_E2E_STALE_GENERAL_WAIT_MS ?? "61500",
    );
    const controlDir = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_CONTROL_DIR"));
    const screenshotPath = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_SCREENSHOT"));
    const screenshotBeforePath = path.join(path.dirname(screenshotPath), "new-task-before-click.png");
    const screenshotUsablePath = path.join(path.dirname(screenshotPath), "new-task-usable.png");
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
      await $(`//*[normalize-space(text())='${generalCacheWitness}']`).waitForDisplayed({
        timeout: 30_000,
      });

      const existingThread = await $(
        `//button[.//span[normalize-space(text())='${existingThreadTitle}']]`,
      );
      await existingThread.waitForClickable({ timeout: 30_000 });
      await existingThread.click();
      await browser.waitUntil(
        async () => (await existingThread.getAttribute("class")).includes("bg-accent/10"),
        {
          timeout: 10_000,
          timeoutMsg: "Existing task did not become selected",
        },
      );
      // General history was loaded during initial DM navigation. Keep the
      // existing task selected beyond useChannelChat's production staleTime so
      // the New task transition proves a stale General query remains disabled.
      await browser.pause(staleGeneralWaitMs);

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
      expect(offline.threadCountBefore).toBe(1);

      await browser.execute(() => {
        window.__newTaskNetworkRecords.fetches.length = 0;
        window.__newTaskNetworkRecords.websocketSends.length = 0;
      });

      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await browser.saveScreenshot(screenshotBeforePath);
      const clickStartedAt = new Date().toISOString();
      await newTaskButton.click();

      const draftRow = await $("[data-testid='hermes-local-task-draft']");
      await draftRow.waitForDisplayed({ timeout: 5_000 });
      expect(await draftRow.getAttribute("aria-current")).toBe("true");
      expect(await draftRow.getText()).toContain("Draft, not saved");
      expect(await composer.isDisplayed()).toBe(true);
      expect(await composer.getText()).toBe("");
      await browser.saveScreenshot(screenshotPath);

      // The blocking stale-General failure retried after roughly 1.1 seconds.
      // Keep the boundary open long enough to catch both the initial request
      // and a retry rather than only asserting the synchronous click frame.
      await browser.pause(2_000);
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

      await composer.click();
      await composer.addValue("unsent usability probe");
      await browser.waitUntil(
        async () => (await composer.getText()).includes("unsent usability probe"),
        {
          timeout: 5_000,
          timeoutMsg: "Local draft composer did not accept unsent text",
        },
      );
      await browser.saveScreenshot(screenshotUsablePath);
      const postUsabilityNetwork = await browser.execute(() => ({
        fetches: [...window.__newTaskNetworkRecords.fetches],
        websocketSends: [...window.__newTaskNetworkRecords.websocketSends],
      }));
      fs.writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            ok: true,
            conversationId,
            existingThreadTitle,
            generalCacheWitness,
            staleGeneralWaitMs,
            clickStartedAt,
            draftVisible: true,
            composerAcceptedUnsentProbe: true,
            network,
            postUsabilityNetwork,
            offline,
            database,
            screenshots: {
              before: screenshotBeforePath,
              after: screenshotPath,
              usable: screenshotUsablePath,
            },
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
