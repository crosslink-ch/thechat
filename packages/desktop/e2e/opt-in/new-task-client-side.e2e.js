import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.NEW_TASK_CLIENT_SIDE_E2E === "1";
const describeNewTask = enabled ? describe : describe.skip;
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(packageDir, "../..");
const evidenceHelper = path.resolve(repoRoot, "scripts/e2e/e2e_run.py");

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

function sourceIdentity() {
  return JSON.parse(
    execFileSync(
      process.env.PYTHON ?? "python3",
      [evidenceHelper, "source", "--root", repoRoot],
      { cwd: repoRoot, encoding: "utf8" },
    ),
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertIdentity(expected, actual, label) {
  for (const key of [
    "commit",
    "tree",
    "dirty",
    "statusSha256",
    "sourceManifestSha256",
    "manifestFileCount",
  ]) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label}: ${key} mismatch (${JSON.stringify(actual[key])} !== ${JSON.stringify(expected[key])})`,
      );
    }
  }
}

async function networkRecords() {
  return browser.execute(() => ({
    fetches: [...window.__newTaskNetworkRecords.fetches],
    xhrs: [...window.__newTaskNetworkRecords.xhrs],
    tauriInvokes: [...window.__newTaskNetworkRecords.tauriInvokes],
    websocketSends: [...window.__newTaskNetworkRecords.websocketSends],
    appBoundaries: [...window.__newTaskNetworkRecords.appBoundaries],
  }));
}

async function attachComposerFile(filePath) {
  await browser.execute(() => {
    const input = document.querySelector("input[type='file']");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("composer file input not found");
    }
    input.classList.remove("hidden");
    input.style.display = "block";
  });
  const fileInput = await $("input[type='file']");
  await fileInput.waitForDisplayed({ timeout: 5_000 });
  await fileInput.setValue(filePath);
  await browser.execute(() => {
    const input = document.querySelector("input[type='file']");
    if (input instanceof HTMLInputElement) {
      input.style.removeProperty("display");
      input.classList.add("hidden");
    }
  });
}

describeNewTask("client-only Hermes New task", () => {
  it("keeps the production New task boundary blank, queue-free, and retry-safe", async function () {
    this.timeout(240_000);

    const email = required("NEW_TASK_CLIENT_SIDE_E2E_EMAIL");
    const password = required("NEW_TASK_CLIENT_SIDE_E2E_PASSWORD");
    const botName = required("NEW_TASK_CLIENT_SIDE_E2E_BOT_NAME");
    const conversationId = required("NEW_TASK_CLIENT_SIDE_E2E_CONVERSATION_ID");
    const existingThreadTitle = required("NEW_TASK_CLIENT_SIDE_E2E_EXISTING_THREAD_TITLE");
    const generalCacheWitness = required("NEW_TASK_CLIENT_SIDE_E2E_GENERAL_CACHE_WITNESS");
    const attachmentPath = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_ATTACHMENT"));
    const buildEvidencePath = path.resolve(
      required("NEW_TASK_CLIENT_SIDE_E2E_BUILD_EVIDENCE"),
    );
    const staleGeneralWaitMs = Number(
      process.env.NEW_TASK_CLIENT_SIDE_E2E_STALE_GENERAL_WAIT_MS ?? "61500",
    );
    const controlDir = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_CONTROL_DIR"));
    const screenshotPath = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_SCREENSHOT"));
    const screenshotBeforePath = path.join(
      path.dirname(screenshotPath),
      "new-task-before-click.png",
    );
    const screenshotUsablePath = path.join(
      path.dirname(screenshotPath),
      "new-task-retryable.png",
    );
    const evidencePath = path.resolve(required("NEW_TASK_CLIENT_SIDE_E2E_EVIDENCE"));
    const offlineRequest = path.join(controlDir, "offline.request");
    const offlineEvidencePath = path.join(controlDir, "offline.json");
    const verifyRequest = path.join(controlDir, "verify-database.request");
    const databaseEvidencePath = path.join(controlDir, "database.json");
    const reconnectRequest = path.join(controlDir, "reconnect.request");
    const onlineEvidencePath = path.join(controlDir, "online.json");
    const finalDatabaseRequest = path.join(controlDir, "final-database.request");
    const finalDatabaseEvidencePath = path.join(controlDir, "final-database.json");
    const oldDraftText = "old selected-task draft must never send";
    const retryablePrompt = required(
      "NEW_TASK_CLIENT_SIDE_E2E_RETRYABLE_PROMPT",
    );

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
      await $(`//*[normalize-space(text())='${botName}']`).waitForDisplayed({
        timeout: 30_000,
      });
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
      await browser.pause(staleGeneralWaitMs);

      let composer = await $("div[contenteditable='true']");
      await composer.waitForDisplayed({ timeout: 30_000 });
      await composer.click();
      await composer.addValue(oldDraftText);
      await attachComposerFile(attachmentPath);
      await $("img[src^='data:image/png;base64,']").waitForExist({ timeout: 5_000 });

      await browser.execute(() => {
        const records = {
          fetches: [],
          xhrs: [],
          tauriInvokes: [],
          websocketSends: [],
          appBoundaries: [],
        };
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
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          records.xhrs.push({ method, url: String(url) });
          return originalXhrOpen.call(this, method, url, ...rest);
        };
        const tauriInternals = window.__TAURI_INTERNALS__;
        if (tauriInternals?.invoke) {
          const originalInvoke = tauriInternals.invoke.bind(tauriInternals);
          tauriInternals.invoke = (command, args, options) => {
            records.tauriInvokes.push(String(command));
            return originalInvoke(command, args, options);
          };
        }
        const originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          let type = "<binary>";
          if (typeof data === "string") {
            try {
              type = JSON.parse(data).type ?? "<json-without-type>";
            } catch {
              type = "<non-json>";
            }
          }
          // Record the transport boundary without persisting auth tokens or
          // message content in machine evidence.
          records.websocketSends.push({ type });
          return originalSend.call(this, data);
        };
        window.addEventListener("thechat:websocket-boundary", (event) => {
          records.appBoundaries.push({ ...event.detail });
        });
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
        for (const key of Object.keys(window.__newTaskNetworkRecords)) {
          window.__newTaskNetworkRecords[key].length = 0;
        }
      });

      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await browser.saveScreenshot(screenshotBeforePath);
      const clickStartedAt = new Date().toISOString();
      const newTaskButton = await $("button[aria-label='New task']");
      await newTaskButton.waitForClickable({ timeout: 30_000 });
      await newTaskButton.click();

      const draftRow = await $("[data-testid='hermes-local-task-draft']");
      await draftRow.waitForDisplayed({ timeout: 5_000 });
      expect(await draftRow.getAttribute("aria-current")).toBe("true");
      expect(await draftRow.getText()).toContain("Draft, not saved");
      composer = await $("div[contenteditable='true']");
      expect(await composer.getText()).toBe("");
      expect(await $("img[src^='data:image/png;base64,']").isExisting()).toBe(false);
      await browser.saveScreenshot(screenshotPath);

      await browser.pause(2_000);
      const clickBoundary = await networkRecords();
      expect(clickBoundary.fetches).toEqual([]);
      expect(clickBoundary.xhrs).toEqual([]);
      expect(
        clickBoundary.tauriInvokes.filter((command) =>
          command.toLowerCase().includes("http"),
        ),
      ).toEqual([]);
      expect(clickBoundary.websocketSends).toEqual([]);
      expect(clickBoundary.appBoundaries).toEqual([]);

      fs.writeFileSync(verifyRequest, "verify\n", { flag: "wx" });
      const database = await waitForJson(
        databaseEvidencePath,
        "database side-effect evidence",
      );
      expect(database.threadCountAfter).toBe(offline.threadCountBefore);
      expect(database.apiReachable).toBe(false);
      composer = await $("div[contenteditable='true']");
      await composer.click();
      await composer.addValue(retryablePrompt);
      await attachComposerFile(attachmentPath);
      const retryImage = await $("img[src^='data:image/png;base64,']");
      await retryImage.waitForExist({ timeout: 5_000 });
      await $("button[title='Send message']").click();
      const sendError = await $("[role='alert']");
      await sendError.waitForDisplayed({ timeout: 15_000 });
      expect(await sendError.getText()).toContain("Could not create the task");
      expect(await composer.getText()).toContain(retryablePrompt);
      expect(await retryImage.isExisting()).toBe(true);
      await browser.saveScreenshot(screenshotUsablePath);

      fs.writeFileSync(reconnectRequest, "reconnect\n", { flag: "wx" });
      const online = await waitForJson(onlineEvidencePath, "controlled reconnect evidence");
      expect(online.apiReachable).toBe(true);
      expect(online.postgresReachable).toBe(true);
      expect(online.redisReachable).toBe(true);
      expect(online.threadCountAfterReconnect).toBe(offline.threadCountBefore);

      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            window.__newTaskNetworkRecords.appBoundaries.some(
              (record) => record.operation === "pending_flush_started",
            ),
          ),
        {
          timeout: 45_000,
          interval: 250,
          timeoutMsg: "WebSocket did not complete the controlled reconnect",
        },
      );
      const reconnectBoundary = await networkRecords();
      const flushes = reconnectBoundary.appBoundaries.filter(
        (record) => record.operation === "pending_flush_started",
      );
      expect(flushes.at(-1).pendingMessageCount).toBe(0);
      expect(flushes.at(-1).pendingEventTypes).toEqual([]);
      expect(
        reconnectBoundary.appBoundaries.filter(
          (record) =>
            record.operation === "send_message_requested" ||
            record.operation === "message_queued" ||
            record.operation === "message_transported",
        ),
      ).toEqual([]);
      expect(
        reconnectBoundary.websocketSends
          .map((record) => record.type)
          .filter((type) => type === "send_message"),
      ).toEqual([]);

      await $("button[title='Send message']").click();
      await browser.waitUntil(
        async () => {
          const localDraft = await $("[data-testid='hermes-local-task-draft']");
          return !(await localDraft.isExisting());
        },
        {
          timeout: 30_000,
          interval: 100,
          timeoutMsg: "Accepted retry did not replace the local task draft",
        },
      );
      const persistedTaskRow = await $(
        `//button[.//span[normalize-space(text())='${retryablePrompt}']]`,
      );
      await persistedTaskRow.waitForDisplayed({ timeout: 30_000 });
      await browser.waitUntil(
        async () => (await persistedTaskRow.getAttribute("class")).includes("bg-accent/10"),
        {
          timeout: 10_000,
          timeoutMsg: "Persisted task did not become the selected task",
        },
      );
      await browser.waitUntil(async () => (await composer.getText()) === "", {
        timeout: 10_000,
        timeoutMsg: "Accepted retry did not clear the composer",
      });
      expect(await retryImage.isExisting()).toBe(false);

      fs.writeFileSync(finalDatabaseRequest, "verify\n", { flag: "wx" });
      const finalDatabase = await waitForJson(
        finalDatabaseEvidencePath,
        "final database evidence",
      );
      expect(finalDatabase.threadCountFinal).toBe(2);
      expect(finalDatabase.messageContents).toContain(retryablePrompt);
      expect(finalDatabase.messageContents).not.toContain(oldDraftText);

      const buildEvidence = JSON.parse(fs.readFileSync(buildEvidencePath, "utf8"));
      expect(buildEvidence.runId).toBe(required("THECHAT_E2E_RUN_ID"));
      assertIdentity(buildEvidence.git, sourceIdentity(), "Before UI evidence finalization");
      expect(sha256File(buildEvidence.binary.path)).toBe(
        buildEvidence.binary.sha256,
      );
      const binding = {
        schemaVersion: buildEvidence.schemaVersion,
        runId: buildEvidence.runId,
        git: buildEvidence.git,
        binary: buildEvidence.binary,
        resources: buildEvidence.resources,
        startedAt: buildEvidence.startedAt,
        endedAt: new Date().toISOString(),
        testCommand: buildEvidence.testCommand,
      };
      const evidence = {
        ok: true,
        binding,
        conversationId,
        existingThreadTitle,
        generalCacheWitness,
        staleGeneralWaitMs,
        clickStartedAt,
        blankDraft: {
          text: true,
          attachments: true,
          oldPromptNeverSent: true,
        },
        firstSendFailure: {
          promptRetained: true,
          attachmentRetained: true,
          retryAccepted: true,
          localDraftRemoved: true,
          persistedTaskSelected: true,
        },
        clickBoundary,
        reconnectBoundary,
        offline,
        database,
        online,
        finalDatabase,
        screenshots: {
          before: screenshotBeforePath,
          after: screenshotPath,
          retryable: screenshotUsablePath,
        },
      };
      const pendingEvidencePath = `${evidencePath}.pending-${binding.runId}`;
      fs.writeFileSync(pendingEvidencePath, JSON.stringify(evidence, null, 2), {
        flag: "wx",
      });
      assertIdentity(buildEvidence.git, sourceIdentity(), "UI evidence source drift");
      expect(sha256File(buildEvidence.binary.path)).toBe(
        buildEvidence.binary.sha256,
      );
      fs.renameSync(pendingEvidencePath, evidencePath);
    } catch (error) {
      const failurePath = path.resolve(
        path.dirname(screenshotPath),
        "new-task-client-side-failure.png",
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
