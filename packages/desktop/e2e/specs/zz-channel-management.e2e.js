import fs from "node:fs";
import path from "node:path";

const API_URL =
  process.env.THECHAT_BACKEND_URL ||
  `http://localhost:${process.env.THECHAT_BACKEND_PORT || "3000"}`;
const EVIDENCE_DIR = process.env.CHANNEL_MANAGEMENT_E2E_EVIDENCE_DIR?.trim();

async function saveEvidence(name) {
  if (!EVIDENCE_DIR) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await browser.saveScreenshot(path.join(EVIDENCE_DIR, name));
}

async function apiRequest(token, method, route, body) {
  return browser.execute(
    async (apiUrl, accessToken, requestMethod, requestRoute, requestBody) => {
      const response = await fetch(`${apiUrl}${requestRoute}`, {
        method: requestMethod,
        headers: {
          ...(requestBody === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          authorization: `Bearer ${accessToken}`,
        },
        body:
          requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
      const text = await response.text();
      let responseBody;
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        responseBody = text;
      }
      return { ok: response.ok, status: response.status, body: responseBody };
    },
    API_URL,
    token,
    method,
    route,
    body,
  );
}

async function waitForChannel(channelId, present = true) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (id) => Boolean(document.querySelector(`[data-channel-id="${id}"]`)),
        channelId,
      )) === present,
    {
      timeout: 10_000,
      timeoutMsg: `Channel ${channelId} did not become ${present ? "visible" : "hidden"}`,
    },
  );
}

describe("Channel management", function () {
  this.timeout(180_000);

  it("creates a channel and receives rename/delete lifecycle updates in the native app", async () => {
    const suffix = Date.now();
    const email = `e2e-channel-${suffix}@e2e.local`;
    const password = "password123";
    const workspaceName = `Channel E2E ${suffix}`;

    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15_000, timeoutMsg: "React never mounted children into #root" },
    );

    const setup = await browser.execute(
      async (apiUrl, accountEmail, accountPassword, name) => {
        async function jsonFetch(route, init) {
          const response = await fetch(`${apiUrl}${route}`, init);
          const text = await response.text();
          let body;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          return { ok: response.ok, status: response.status, body };
        }

        const registered = await jsonFetch("/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Channel E2E User",
            email: accountEmail,
            password: accountPassword,
          }),
        });
        if (!registered.ok || !registered.body?.accessToken) {
          return {
            error: `register: ${registered.status} ${JSON.stringify(registered.body)}`,
          };
        }
        const token = registered.body.accessToken;
        const workspace = await jsonFetch("/workspaces/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ name }),
        });
        if (!workspace.ok || !workspace.body?.id) {
          return {
            error: `workspace: ${workspace.status} ${JSON.stringify(workspace.body)}`,
          };
        }
        const details = await jsonFetch(`/workspaces/${workspace.body.id}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const generalId = details.body?.channels?.[0]?.id;
        if (!details.ok || !generalId) {
          return {
            error: `workspace detail: ${details.status} ${JSON.stringify(details.body)}`,
          };
        }
        return { token, workspaceId: workspace.body.id, generalId };
      },
      API_URL,
      email,
      password,
      workspaceName,
    );
    if (setup.error) throw new Error(`API setup failed: ${setup.error}`);

    const loginButton = await $("button*=Log in");
    await loginButton.waitForClickable({ timeout: 10_000 });
    await loginButton.click();
    const emailInput = await $("#auth-email");
    await emailInput.waitForExist({ timeout: 5_000 });
    await emailInput.setValue(email);
    await $("#auth-password").setValue(password);
    await $("button[type='submit']").click();
    await emailInput.waitForExist({ reverse: true, timeout: 10_000 });
    await $(`button[data-channel-id="${setup.generalId}"]`).waitForExist({
      timeout: 10_000,
    });

    const createButton = await $('button[aria-label="Create channel"]');
    await createButton.click();
    const nameInput = await $('input[aria-label="Channel name"]');
    await nameInput.waitForExist({ timeout: 5_000 });
    const dialogBackgroundColor = await browser.execute(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog ? window.getComputedStyle(dialog).backgroundColor : null;
    });
    if (
      !dialogBackgroundColor ||
      dialogBackgroundColor === "transparent" ||
      dialogBackgroundColor === "rgba(0, 0, 0, 0)"
    ) {
      throw new Error(
        `Channel dialog must have an opaque background, got ${dialogBackgroundColor}`,
      );
    }
    await saveEvidence("channel-management-1-create-dialog.png");
    await nameInput.setValue("Launch Room");
    await $("button=Create channel").click();
    await nameInput.waitForExist({ reverse: true, timeout: 10_000 });

    const createdChannelId = await browser.execute(() =>
      window.location.hash.replace(/^#\/channel\//, "").split("?")[0],
    );
    if (!/^[0-9a-f-]{36}$/i.test(createdChannelId)) {
      throw new Error(`Could not determine the created channel id: ${createdChannelId}`);
    }
    await waitForChannel(createdChannelId);

    await saveEvidence("channel-management-2-created-channel.png");

    const renamedCreatedChannel = await apiRequest(
      setup.token,
      "PATCH",
      `/conversations/channel/${createdChannelId}`,
      { name: "Release Room" },
    );
    if (!renamedCreatedChannel.ok) {
      throw new Error(
        `Realtime channel rename failed: ${renamedCreatedChannel.status} ${JSON.stringify(renamedCreatedChannel.body)}`,
      );
    }
    await $('button[aria-label="Manage #release-room"]').waitForExist({
      timeout: 10_000,
    });
    await saveEvidence("channel-management-3-realtime-renamed.png");

    const deletedCreatedChannel = await apiRequest(
      setup.token,
      "DELETE",
      `/conversations/channel/${createdChannelId}`,
    );
    if (!deletedCreatedChannel.ok) {
      throw new Error(
        `Realtime channel delete failed: ${deletedCreatedChannel.status} ${JSON.stringify(deletedCreatedChannel.body)}`,
      );
    }
    await waitForChannel(createdChannelId, false);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.location.hash)) ===
        `#/channel/${setup.generalId}`,
      {
        timeout: 10_000,
        timeoutMsg: "Realtime deletion did not reroute the active client",
      },
    );

    await browser.pause(500);
    const realtimeCreated = await apiRequest(
      setup.token,
      "POST",
      "/conversations/channel",
      { workspaceId: setup.workspaceId, name: "Realtime Room" },
    );
    if (!realtimeCreated.ok || !realtimeCreated.body?.id) {
      throw new Error(
        `Realtime channel create failed: ${realtimeCreated.status} ${JSON.stringify(realtimeCreated.body)}`,
      );
    }
    const realtimeChannelId = realtimeCreated.body.id;
    await waitForChannel(realtimeChannelId);
    await saveEvidence("channel-management-4-realtime-created.png");

    await $(`button[data-channel-id="${realtimeChannelId}"]`).click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.location.hash)) ===
        `#/channel/${realtimeChannelId}`,
      { timeout: 10_000, timeoutMsg: "Realtime channel never became active" },
    );
    const realtimeRenamed = await apiRequest(
      setup.token,
      "PATCH",
      `/conversations/channel/${realtimeChannelId}`,
      { name: "Synced Room" },
    );
    if (!realtimeRenamed.ok) {
      throw new Error(
        `Realtime channel rename failed: ${realtimeRenamed.status} ${JSON.stringify(realtimeRenamed.body)}`,
      );
    }
    await $('button[aria-label="Manage #synced-room"]').waitForExist({
      timeout: 10_000,
    });

    const realtimeDeleted = await apiRequest(
      setup.token,
      "DELETE",
      `/conversations/channel/${realtimeChannelId}`,
    );
    if (!realtimeDeleted.ok) {
      throw new Error(
        `Realtime channel delete failed: ${realtimeDeleted.status} ${JSON.stringify(realtimeDeleted.body)}`,
      );
    }
    await waitForChannel(realtimeChannelId, false);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.location.hash)) ===
        `#/channel/${setup.generalId}`,
      {
        timeout: 10_000,
        timeoutMsg: "Realtime deletion did not reroute the active client",
      },
    );
  });
});
