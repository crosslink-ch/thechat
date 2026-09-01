import fs from "node:fs";
import path from "node:path";

const API_URL =
  process.env.THECHAT_BACKEND_URL ||
  `http://localhost:${process.env.THECHAT_BACKEND_PORT || "3000"}`;
const EVIDENCE_DIR = process.env.PRIVATE_CHANNEL_E2E_EVIDENCE_DIR?.trim();

async function saveEvidence(name) {
  if (!EVIDENCE_DIR) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await browser.saveScreenshot(path.join(EVIDENCE_DIR, name));
}

async function login(email, password) {
  const loginButton = await $("button*=Log in");
  await loginButton.waitForClickable({ timeout: 10_000 });
  await loginButton.click();
  const emailInput = await $("#auth-email");
  await emailInput.waitForExist({ timeout: 5_000 });
  await emailInput.setValue(email);
  await $("#auth-password").setValue(password);
  await $("button[type='submit']").click();
  await emailInput.waitForExist({ reverse: true, timeout: 10_000 });
}

async function logout(displayName) {
  const profile = await $(`button*=${displayName}`);
  await profile.waitForClickable({ timeout: 10_000 });
  await profile.click();
  const logoutButton = await $("button*=Log out");
  await logoutButton.waitForClickable({ timeout: 5_000 });
  await logoutButton.click();
  await $("button*=Log in").waitForExist({ timeout: 10_000 });
}

async function apiRequest(token, method, route, body) {
  return browser.execute(
    async (apiUrl, accessToken, requestMethod, requestRoute, requestBody) => {
      const response = await fetch(`${apiUrl}${requestRoute}`, {
        method: requestMethod,
        headers: {
          ...(requestBody == null
            ? {}
            : { "Content-Type": "application/json" }),
          authorization: `Bearer ${accessToken}`,
        },
        body: requestBody == null ? undefined : JSON.stringify(requestBody),
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
      timeoutMsg: `Private channel ${channelId} did not become ${present ? "visible" : "hidden"}`,
    },
  );
}

describe("Private channels", function () {
  this.timeout(180_000);

  it("shows a private channel only to selected workspace members", async () => {
    const suffix = `${Date.now().toString().slice(-6)}${Math.random().toString(16).slice(2, 6)}`;
    const password = "password123";
    const ownerEmail = `morgan.${suffix}@e2e.local`;
    const selectedEmail = `avery.${suffix}@e2e.local`;
    const excludedEmail = `nora.${suffix}@e2e.local`;
    const workspaceName = "Northstar Studio";

    await browser.setWindowSize(1280, 900);
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15_000, timeoutMsg: "React never mounted children into #root" },
    );

    const setup = await browser.execute(
      async (
        apiUrl,
        ownerAccountEmail,
        selectedAccountEmail,
        excludedAccountEmail,
        accountPassword,
        name,
      ) => {
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

        async function register(displayName, email) {
          return jsonFetch("/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: displayName,
              email,
              password: accountPassword,
            }),
          });
        }

        const owner = await register("Morgan Lee", ownerAccountEmail);
        const selected = await register("Avery Stone", selectedAccountEmail);
        const excluded = await register("Nora Reed", excludedAccountEmail);
        for (const [label, result] of [
          ["owner", owner],
          ["selected", selected],
          ["excluded", excluded],
        ]) {
          if (!result.ok || !result.body?.accessToken || !result.body?.user?.id) {
            return {
              error: `${label} register: ${result.status} ${JSON.stringify(result.body)}`,
            };
          }
        }

        const workspace = await jsonFetch("/workspaces/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${owner.body.accessToken}`,
          },
          body: JSON.stringify({ name }),
        });
        if (!workspace.ok || !workspace.body?.id) {
          return {
            error: `workspace: ${workspace.status} ${JSON.stringify(workspace.body)}`,
          };
        }

        async function inviteAndAccept(member) {
          const invite = await jsonFetch("/invites/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${owner.body.accessToken}`,
            },
            body: JSON.stringify({
              workspaceId: workspace.body.id,
              email: member.body.user.email,
            }),
          });
          if (!invite.ok || !invite.body?.id) return invite;
          return jsonFetch("/invites/accept", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${member.body.accessToken}`,
            },
            body: JSON.stringify({ inviteId: invite.body.id }),
          });
        }

        const selectedAccepted = await inviteAndAccept(selected);
        const excludedAccepted = await inviteAndAccept(excluded);
        if (!selectedAccepted.ok || !excludedAccepted.ok) {
          return {
            error: `invite acceptance: ${selectedAccepted.status}/${excludedAccepted.status}`,
          };
        }

        const details = await jsonFetch(`/workspaces/${workspace.body.id}`, {
          headers: { authorization: `Bearer ${owner.body.accessToken}` },
        });
        const generalId = details.body?.channels?.find(
          (channel) => channel.name === "general",
        )?.id;
        if (!details.ok || !generalId) {
          return {
            error: `workspace detail: ${details.status} ${JSON.stringify(details.body)}`,
          };
        }

        return {
          workspaceId: workspace.body.id,
          generalId,
          ownerToken: owner.body.accessToken,
          selectedToken: selected.body.accessToken,
          selectedUserId: selected.body.user.id,
          excludedToken: excluded.body.accessToken,
        };
      },
      API_URL,
      ownerEmail,
      selectedEmail,
      excludedEmail,
      password,
      workspaceName,
    );
    if (setup.error) throw new Error(`API setup failed: ${setup.error}`);

    await login(ownerEmail, password);
    await $(`button[data-channel-id="${setup.generalId}"]`).waitForExist({
      timeout: 10_000,
    });

    await $('button[aria-label="Create channel"]').click();
    const nameInput = await $('input[aria-label="Channel name"]');
    await nameInput.waitForExist({ timeout: 5_000 });
    await nameInput.setValue("Leadership");
    await $("//label[contains(., 'Private')]//input[@type='radio']").click();
    const selectedMember = await $('input[aria-label="Include Avery Stone"]');
    await selectedMember.waitForClickable({ timeout: 5_000 });
    await selectedMember.click();
    await browser.waitUntil(
      async () =>
        (await selectedMember.isSelected()) &&
        (await browser.getPageSource()).includes("2 selected"),
      {
        timeout: 5_000,
        timeoutMsg: "Selected-member state did not render in the dialog",
      },
    );
    const excludedMember = await $('input[aria-label="Include Nora Reed"]');
    if (await excludedMember.isSelected()) {
      throw new Error("Unselected member was checked by default");
    }
    await saveEvidence("private-channels-1-create-dialog.png");

    await $("button=Create channel").click();
    await nameInput.waitForExist({ reverse: true, timeout: 10_000 });
    const privateChannelId = await browser.execute(() =>
      window.location.hash.replace(/^#\/channel\//, "").split("?")[0],
    );
    if (!/^[0-9a-f-]{36}$/i.test(privateChannelId)) {
      throw new Error(`Could not determine private channel id: ${privateChannelId}`);
    }
    await waitForChannel(privateChannelId, true);
    await $(`button[data-channel-id="${privateChannelId}"] svg[aria-label="Private channel"]`).waitForExist({
      timeout: 5_000,
    });

    const selectedWorkspace = await apiRequest(
      setup.selectedToken,
      "GET",
      `/workspaces/${setup.workspaceId}`,
    );
    const excludedWorkspace = await apiRequest(
      setup.excludedToken,
      "GET",
      `/workspaces/${setup.workspaceId}`,
    );
    if (
      !selectedWorkspace.ok ||
      !selectedWorkspace.body.channels.some(
        (channel) => channel.id === privateChannelId && channel.isPrivate === true,
      )
    ) {
      throw new Error("Selected member could not discover the private channel");
    }
    if (
      !excludedWorkspace.ok ||
      excludedWorkspace.body.channels.some(
        (channel) => channel.id === privateChannelId,
      )
    ) {
      throw new Error("Unselected member discovered the private channel");
    }

    const excludedDetail = await apiRequest(
      setup.excludedToken,
      "GET",
      `/conversations/detail/${privateChannelId}`,
    );
    if (excludedDetail.status !== 403) {
      throw new Error(
        `Unselected detail access returned ${excludedDetail.status} instead of 403`,
      );
    }
    const excludedMessage = await apiRequest(
      setup.excludedToken,
      "POST",
      `/messages/${privateChannelId}`,
      { content: "This write must be rejected" },
    );
    if (excludedMessage.status !== 403) {
      throw new Error(
        `Unselected message access returned ${excludedMessage.status} instead of 403`,
      );
    }

    await saveEvidence("private-channels-2-authorized-view.png");

    await logout("Morgan Lee");
    await login(excludedEmail, password);
    await $(`button[data-channel-id="${setup.generalId}"]`).waitForExist({
      timeout: 10_000,
    });
    await waitForChannel(privateChannelId, false);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.location.hash)) ===
        `#/channel/${setup.generalId}`,
      {
        timeout: 10_000,
        timeoutMsg: "Hidden private-channel route did not fall back to a visible channel",
      },
    );
    await browser.waitUntil(
      async () => (await browser.getPageSource()).includes("No messages yet"),
      {
        timeout: 10_000,
        timeoutMsg: "Fallback channel did not finish loading",
      },
    );
    await saveEvidence("private-channels-3-unselected-member.png");
  });
});
