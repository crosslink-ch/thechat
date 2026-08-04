// Native E2E coverage for workspace user and bot management.
//
// The test creates three accounts and two bots through the real API, then uses
// the Tauri UI to invite/remove a person, add an owned bot immediately, and
// request/approve a bot owned by someone else.

const API_URL =
  process.env.THECHAT_BACKEND_URL ||
  `http://localhost:${process.env.THECHAT_BACKEND_PORT || "3000"}`;

async function waitForTestId(testId, timeout = 10000) {
  const element = await $(`[data-testid="${testId}"]`);
  await element.waitForExist({ timeout });
  return element;
}

async function clickButtonWithin(element, label) {
  const button = await element.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 5000 });
  await button.click();
}

describe("Workspace access management", function () {
  this.timeout(120_000);

  it("manages people and bot approvals from Manage workspace", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const password = "password123";
    const ownerEmail = `e2e-workspace-owner-${suffix}@e2e.local`;
    const memberEmail = `e2e-workspace-member-${suffix}@e2e.local`;
    const botOwnerEmail = `e2e-bot-owner-${suffix}@e2e.local`;
    const workspaceName = `E2E Workspace ${suffix}`;

    await browser.waitUntil(
      async () =>
        browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15000, timeoutMsg: "React never mounted into #root" },
    );

    const setup = await browser.execute(
      async (
        apiUrl,
        password,
        ownerEmail,
        memberEmail,
        botOwnerEmail,
        workspaceName,
      ) => {
        async function jsonFetch(path, init) {
          const response = await fetch(`${apiUrl}${path}`, init);
          const text = await response.text();
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          if (!response.ok) {
            throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
          }
          return body;
        }

        async function register(name, email) {
          const body = await jsonFetch("/auth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, email, password }),
          });
          return { token: body.accessToken, user: body.user };
        }

        const owner = await register("E2E Workspace Owner", ownerEmail);
        const member = await register("E2E Workspace Member", memberEmail);
        const botOwner = await register("E2E Bot Owner", botOwnerEmail);
        const auth = (token) => ({
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        });

        const workspace = await jsonFetch("/workspaces/create", {
          method: "POST",
          headers: auth(owner.token),
          body: JSON.stringify({ name: workspaceName }),
        });
        const ownedBot = await jsonFetch("/bots/create", {
          method: "POST",
          headers: auth(owner.token),
          body: JSON.stringify({ name: "E2E Owned Bot", kind: "webhook" }),
        });
        const externalBot = await jsonFetch("/bots/create", {
          method: "POST",
          headers: auth(botOwner.token),
          body: JSON.stringify({ name: "E2E External Bot", kind: "webhook" }),
        });

        return {
          workspace,
          owner,
          member,
          botOwner,
          ownedBot,
          externalBot,
        };
      },
      API_URL,
      password,
      ownerEmail,
      memberEmail,
      botOwnerEmail,
      workspaceName,
    );

    const sidebarLogin = await $("button*=Log in");
    await sidebarLogin.waitForClickable({ timeout: 10000 });
    await sidebarLogin.click();
    const emailInput = await $("#auth-email");
    await emailInput.waitForExist({ timeout: 5000 });
    await emailInput.setValue(ownerEmail);
    await $("#auth-password").setValue(password);
    await $("button[type='submit']").click();
    await emailInput.waitForExist({ reverse: true, timeout: 10000 });

    // Visiting the workspace home lets the one-workspace auto-selection run.
    // Directly opening Manage workspace before that would correctly render the
    // empty "select a workspace" state.
    await browser.execute(() => {
      window.location.hash = "#/";
    });
    await browser.waitUntil(
      async () => (await browser.getPageSource()).includes(setup.workspace.name),
      {
        timeout: 20_000,
        timeoutMsg: "created workspace never became active",
      },
    );

    await browser.execute(() => {
      window.location.hash = "#/workspace/manage";
    });
    const workspaceId = await waitForTestId("workspace-id");
    await browser.waitUntil(
      async () =>
        (await workspaceId.getAttribute("data-workspace-value")) ===
        setup.workspace.id,
      {
        timeout: 10000,
        timeoutMsg: `Workspace ID ${setup.workspace.id} was not displayed`,
      },
    );

    // Invite a person in the UI, then accept from their API session.
    const inviteEmail = await waitForTestId("invite-user-email");
    await inviteEmail.setValue(memberEmail);
    await (await waitForTestId("invite-user-submit")).click();
    await $("div*=Invitation sent").waitForExist({ timeout: 10000 });

    const acceptedMember = await browser.execute(
      async (apiUrl, token) => {
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        };
        const pending = await fetch(`${apiUrl}/invites/pending`, { headers }).then(
          (response) => response.json(),
        );
        if (!pending[0]?.id) return { error: "member invite was not pending" };
        const response = await fetch(`${apiUrl}/invites/accept`, {
          method: "POST",
          headers,
          body: JSON.stringify({ inviteId: pending[0].id }),
        });
        return { ok: response.ok, status: response.status };
      },
      API_URL,
      setup.member.token,
    );
    if (!acceptedMember.ok) {
      throw new Error(`Member invite acceptance failed: ${JSON.stringify(acceptedMember)}`);
    }
    await waitForTestId(`member-row-${setup.member.user.id}`, 10000);

    // The owner-owned bot is attached immediately.
    const botInput = await waitForTestId("bot-id-input");
    await botInput.setValue(setup.ownedBot.id);
    await (await waitForTestId("add-bot-submit")).click();
    await waitForTestId(`bot-row-${setup.ownedBot.id}`, 10000);

    // A bot owned by another account creates a request instead of membership.
    await botInput.setValue(setup.externalBot.id);
    await (await waitForTestId("add-bot-submit")).click();
    await $("div*=Approval requested").waitForExist({ timeout: 10000 });

    const approvedBot = await browser.execute(
      async (apiUrl, token, expectedBotId) => {
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        };
        const pending = await fetch(`${apiUrl}/bot-workspace-invites/pending`, {
          headers,
        }).then((response) => response.json());
        const invite = pending.find((candidate) => candidate.botId === expectedBotId);
        if (!invite) return { error: "bot approval request was not pending" };
        const response = await fetch(`${apiUrl}/bot-workspace-invites/accept`, {
          method: "POST",
          headers,
          body: JSON.stringify({ inviteId: invite.id }),
        });
        return { ok: response.ok, status: response.status };
      },
      API_URL,
      setup.botOwner.token,
      setup.externalBot.id,
    );
    if (!approvedBot.ok) {
      throw new Error(`Bot approval failed: ${JSON.stringify(approvedBot)}`);
    }
    await waitForTestId(`bot-row-${setup.externalBot.id}`, 10000);

    // Remove the invited person and the externally-owned bot through the UI.
    const memberRow = await waitForTestId(`member-row-${setup.member.user.id}`);
    await clickButtonWithin(memberRow, "Remove");
    await clickButtonWithin(memberRow, "Confirm");
    await memberRow.waitForExist({ reverse: true, timeout: 10000 });

    const botRow = await waitForTestId(`bot-row-${setup.externalBot.id}`);
    await clickButtonWithin(botRow, "Remove");
    await clickButtonWithin(botRow, "Confirm");
    await botRow.waitForExist({ reverse: true, timeout: 10000 });
  });
});
