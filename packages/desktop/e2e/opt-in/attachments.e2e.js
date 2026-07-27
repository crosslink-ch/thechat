import crypto from "node:crypto";
import fs from "node:fs";

const API_URL = required("THECHAT_BACKEND_URL");
const EMAIL = required("ATTACHMENT_E2E_EMAIL");
const PASSWORD = required("ATTACHMENT_E2E_PASSWORD");
const TOKEN = required("ATTACHMENT_E2E_TOKEN");
const CONVERSATION_ID = required("ATTACHMENT_E2E_CONVERSATION_ID");
const VALID_FIXTURE = required("ATTACHMENT_E2E_VALID_FIXTURE");
const REJECTED_FIXTURE = required("ATTACHMENT_E2E_REJECTED_FIXTURE");
const CANCEL_FIXTURE = required("ATTACHMENT_E2E_CANCEL_FIXTURE");
const SCREENSHOT = required("ATTACHMENT_E2E_SCREENSHOT");
const SUCCESS_SCREENSHOT = required("ATTACHMENT_E2E_SUCCESS_SCREENSHOT");
const REJECTION_SCREENSHOT = required("ATTACHMENT_E2E_REJECTION_SCREENSHOT");
const FAILURE_SCREENSHOT = required("ATTACHMENT_E2E_FAILURE_SCREENSHOT");

const validName = fileName(VALID_FIXTURE);
const rejectedName = fileName(REJECTED_FIXTURE);
const cancelName = fileName(CANCEL_FIXTURE);

describe("Secure message attachments", function () {
  this.timeout(480_000);

  before(async () => {
    const waitForRoot = () =>
      browser.waitUntil(
        async () =>
          await browser.execute(
            () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
          ),
        {
          timeout: 15_000,
          timeoutMsg: "React never mounted children into #root",
        },
      );
    try {
      await waitForRoot();
    } catch {
      await browser.refresh();
      await waitForRoot();
    }

    const loginButton = await $("button*=Log in");
    await loginButton.waitForClickable({ timeout: 10_000 });
    await loginButton.click();

    const emailInput = await $("#auth-email");
    await emailInput.waitForExist({ timeout: 5_000 });
    await emailInput.setValue(EMAIL);
    await $("#auth-password").setValue(PASSWORD);
    await $("button[type='submit']").click();
    await emailInput.waitForExist({ reverse: true, timeout: 30_000 });

    await browser.execute((conversationId) => {
      window.location.hash = `#/channel/${conversationId}`;
    }, CONVERSATION_ID);
    await $('input[type="file"]').waitForExist({ timeout: 15_000 });
    await $('[data-testid="channel-chat-scroll"]').waitForExist({
      timeout: 15_000,
    });

    await browser.execute(() => {
      const state = {
        transitions: {},
        downloadBlobUrl: null,
        downloadName: null,
        sendProbe: null,
      };
      window.__attachmentE2E = state;
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function attachmentE2EClick() {
        if (this.href.startsWith("blob:") && this.download) {
          state.downloadBlobUrl = this.href;
          state.downloadName = this.download;
          return;
        }
        return originalAnchorClick.call(this);
      };
      const record = () => {
        for (const element of document.querySelectorAll(
          '[data-testid="attachment-draft"]',
        )) {
          const name = element.getAttribute("data-attachment-file-name");
          const phase = element.getAttribute("data-attachment-phase");
          if (!name || !phase) continue;
          const phases = state.transitions[name] ?? [];
          if (phases.at(-1) !== phase) phases.push(phase);
          state.transitions[name] = phases;
        }
      };
      new MutationObserver(record).observe(document.body, {
        attributes: true,
        attributeFilter: ["data-attachment-phase", "data-attachment-id"],
        childList: true,
        subtree: true,
      });
      record();
    });
  });

  after(async () => {
    const flushed = await browser.executeAsync((done) => {
      const flush = window.__thechatOtelForceFlush;
      if (typeof flush !== "function") {
        done({ ok: false, error: "Desktop OTel force-flush hook is missing" });
        return;
      }
      flush().then(
        () => {
          const exports = window.__thechatOtelExports ?? [];
          done({
            ok: exports.some(
              (result) => result.code === 0 && result.spanCount > 0,
            ),
            exports,
          });
        },
        (error) => done({ ok: false, error: String(error), exports: [] }),
      );
    });
    if (!flushed.ok) {
      throw new Error(`Desktop OTel export failed: ${JSON.stringify(flushed)}`);
    }
    console.log(JSON.stringify({ desktopOtelExports: flushed.exports }));
  });

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await browser.saveScreenshot(FAILURE_SCREENSHOT);
    }
  });

  it("uploads, retries an ambiguous send idempotently, renders, and downloads exact bytes", async () => {
    await attachFile(VALID_FIXTURE);
    await waitForDraftPhase(validName, "ready", 180_000);
    await expectDraftText(validName, "Ready");
    await assertTransitions(validName, [
      "hashing",
      "uploading",
      "processing",
      "ready",
    ]);

    await armLostMessageResponse(CONVERSATION_ID);
    const sendButton = await $('button[title="Send message"]');
    await sendButton.waitForEnabled({ timeout: 10_000 });
    await sendButton.click();

    const sendError = await $('[role="alert"]');
    await sendError.waitForExist({ timeout: 30_000 });
    expect(await sendError.getText()).toContain("Could not reach the server");
    const lostAttempt = await browser.execute(
      () => window.__attachmentE2E.sendProbe,
    );
    expect(lostAttempt.requestIds).toHaveLength(1);
    expect(lostAttempt.lostResponses).toBe(1);
    expect(lostAttempt.attempts).toHaveLength(1);
    expect(lostAttempt.attempts[0].responseStatus).toBeGreaterThanOrEqual(200);
    expect(lostAttempt.attempts[0].responseStatus).toBeLessThan(300);
    expect(lostAttempt.attempts[0].responseMessageId).toBeTruthy();
    await waitForDraftPhase(validName, "ready", 10_000);

    await sendButton.waitForEnabled({ timeout: 10_000 });
    await sendButton.click();
    await waitForDraftRemoval(validName, 30_000);
    await sendError.waitForExist({ reverse: true, timeout: 30_000 });

    const fileCard = await $(`button[title="Download ${validName}"]`);
    await fileCard.waitForExist({ timeout: 30_000 });
    const renderedCount = await browser.execute(
      (title) => document.querySelectorAll(`button[title="${title}"]`).length,
      `Download ${validName}`,
    );
    expect(renderedCount).toBe(1);

    const probe = await browser.execute(() => window.__attachmentE2E.sendProbe);
    expect(probe.requestIds).toHaveLength(2);
    expect(probe.requestIds[0]).toBeTruthy();
    expect(probe.requestIds[1]).toBe(probe.requestIds[0]);
    expect(probe.lostResponses).toBe(1);
    expect(probe.attempts).toHaveLength(2);
    expect(probe.attempts[1].responseStatus).toBeGreaterThanOrEqual(200);
    expect(probe.attempts[1].responseStatus).toBeLessThan(300);
    expect(probe.attempts[1].responseMessageId).toBe(
      probe.attempts[0].responseMessageId,
    );

    await fileCard.click();
    await browser.waitUntil(
      async () =>
        Boolean(
          await browser.execute(() => window.__attachmentE2E.downloadBlobUrl),
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Application-controlled attachment transfer did not launch",
      },
    );
    const downloaded = await browser.executeAsync((done) => {
      const state = window.__attachmentE2E;
      fetch(state.downloadBlobUrl)
        .then(async (response) => {
          const bytes = await response.arrayBuffer();
          const digest = await window.crypto.subtle.digest("SHA-256", bytes);
          done({
            ok: response.ok,
            status: response.status,
            size: bytes.byteLength,
            name: state.downloadName,
            sha256: Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
          });
        })
        .catch((error) => done({ ok: false, error: String(error) }));
    });
    expect(downloaded.ok).toBe(true);
    expect(downloaded.status).toBe(200);
    expect(downloaded.name).toBe(validName);
    expect(downloaded.sha256).toBe(sha256(fs.readFileSync(VALID_FIXTURE)));
    await browser.saveScreenshot(SUCCESS_SCREENSHOT);
  });

  it("shows an active-content rejection and keeps the message unsendable", async () => {
    await attachFile(REJECTED_FIXTURE);
    await waitForDraftPhase(rejectedName, "error", 180_000);
    await expectDraftText(
      rejectedName,
      "The attachment was rejected during validation",
    );
    await assertTransitions(rejectedName, [
      "hashing",
      "uploading",
      "processing",
      "error",
    ]);

    const rejected = await draftSnapshot(rejectedName);
    expect(rejected.attachmentId).toBeTruthy();
    const status = await apiJson(`/attachments/${rejected.attachmentId}`);
    expect(status.status).toBe("rejected");
    expect(await $('button[title="Send message"]').isEnabled()).toBe(false);
    await browser.saveScreenshot(REJECTION_SCREENSHOT);

    const remove = await $(`button[aria-label="Remove ${rejectedName}"]`);
    await remove.waitForClickable({ timeout: 10_000 });
    await remove.click();
    await waitForDraftRemoval(rejectedName, 30_000);
    await waitForAttachmentStatus(rejected.attachmentId, "deleted", 120_000);
  });

  it("cancels a ready draft before it is attached to a message", async () => {
    await attachFile(CANCEL_FIXTURE);
    await waitForDraftPhase(cancelName, "ready", 180_000);
    const ready = await draftSnapshot(cancelName);
    expect(ready.attachmentId).toBeTruthy();

    const remove = await $(`button[aria-label="Remove ${cancelName}"]`);
    await remove.waitForClickable({ timeout: 10_000 });
    await remove.click();
    await waitForDraftRemoval(cancelName, 30_000);
    await waitForAttachmentStatus(ready.attachmentId, "deleted", 120_000);
    await browser.saveScreenshot(SCREENSHOT);

    console.log(
      JSON.stringify({
        validName,
        rejectedName,
        cancelName,
        cancelledAttachmentId: ready.attachmentId,
        screenshot: SCREENSHOT,
      }),
    );
  });
});

async function attachFile(path) {
  const input = await $('input[type="file"]');
  await browser.execute(() => {
    const fileInput = document.querySelector('input[type="file"]');
    window.__attachmentE2E.fileInputPresentation = {
      className: fileInput.className,
      style: fileInput.getAttribute("style"),
    };
    fileInput.classList.remove("hidden");
    fileInput.style.cssText =
      "position:fixed;left:0;top:0;width:320px;height:40px;opacity:1;z-index:2147483647;display:block";
  });
  try {
    await input.setValue(path);
  } finally {
    await browser.execute(() => {
      const fileInput = document.querySelector('input[type="file"]');
      const presentation = window.__attachmentE2E.fileInputPresentation;
      fileInput.className = presentation.className;
      if (presentation.style === null) fileInput.removeAttribute("style");
      else fileInput.setAttribute("style", presentation.style);
    });
  }
}

async function waitForDraftPhase(name, phase, timeout) {
  await browser.waitUntil(
    async () => {
      const snapshot = await draftSnapshot(name);
      return snapshot?.phase === phase;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${name} never reached attachment phase ${phase}`,
    },
  );
}

async function waitForDraftRemoval(name, timeout) {
  await browser.waitUntil(async () => (await draftSnapshot(name)) === null, {
    timeout,
    interval: 250,
    timeoutMsg: `${name} draft was not removed`,
  });
}

async function expectDraftText(name, expected) {
  await browser.waitUntil(
    async () => {
      const snapshot = await draftSnapshot(name);
      return snapshot?.text.includes(expected) ?? false;
    },
    { timeout: 30_000, timeoutMsg: `${name} did not render ${expected}` },
  );
}

async function draftSnapshot(name) {
  return browser.execute((fileName) => {
    const draft = Array.from(
      document.querySelectorAll('[data-testid="attachment-draft"]'),
    ).find(
      (candidate) =>
        candidate.getAttribute("data-attachment-file-name") === fileName,
    );
    if (!draft) return null;
    return {
      phase: draft.getAttribute("data-attachment-phase"),
      attachmentId: draft.getAttribute("data-attachment-id"),
      text: draft.textContent ?? "",
    };
  }, name);
}

async function assertTransitions(name, expected) {
  const actual = await browser.execute(
    (fileName) => window.__attachmentE2E.transitions[fileName] ?? [],
    name,
  );
  let previousIndex = -1;
  for (const phase of expected) {
    const index = actual.indexOf(phase, previousIndex + 1);
    if (index < 0) {
      throw new Error(
        `${name} did not reach ${phase} after ${actual[previousIndex] ?? "start"}: ${actual.join(" -> ")}`,
      );
    }
    previousIndex = index;
  }
}

async function armLostMessageResponse(conversationId) {
  await browser.execute((targetConversationId) => {
    const originalFetch = window.fetch.bind(window);
    const probe = { requestIds: [], attempts: [], lostResponses: 0 };
    window.__attachmentE2E.sendProbe = probe;

    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? String(input);
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      let bodyText = typeof init?.body === "string" ? init.body : "";
      if (!bodyText && request) {
        try {
          bodyText = await request.clone().text();
        } catch {
          bodyText = "";
        }
      }
      const response = await originalFetch(input, init);
      const pathname = new URL(url, window.location.href).pathname;
      if (
        method === "POST" &&
        pathname === `/messages/${targetConversationId}`
      ) {
        let requestId = "";
        try {
          requestId = JSON.parse(bodyText).clientMessageId ?? "";
        } catch {
          requestId = "";
        }
        probe.requestIds.push(requestId);
        let responseMessageId = null;
        try {
          const responseBody = await response.clone().json();
          responseMessageId =
            responseBody?.id ?? responseBody?.message?.id ?? null;
        } catch {
          responseMessageId = null;
        }
        probe.attempts.push({
          requestId,
          responseStatus: response.status,
          responseMessageId,
        });
        if (probe.lostResponses === 0) {
          probe.lostResponses += 1;
          throw new TypeError("Simulated lost response after commit");
        }
      }
      return response;
    };
  }, conversationId);
}

async function waitForAttachmentStatus(attachmentId, expectedStatus, timeout) {
  await browser.waitUntil(
    async () => {
      const status = await apiJson(`/attachments/${attachmentId}`);
      return status.status === expectedStatus;
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Attachment ${attachmentId} never reached ${expectedStatus}`,
    },
  );
}

async function apiJson(pathname) {
  const response = await fetch(`${API_URL}${pathname}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`API ${pathname} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function fileName(path) {
  return path.split(/[\\/]/).at(-1);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
