// Native E2E coverage for unread activity across workspaces.
//
// The test keeps Workspace Alpha selected, sends a real message in Workspace
// Beta, and verifies both the always-visible workspace badge and the unread
// marker inside the workspace switcher before opening the unread channel.

const API_URL =
  process.env.THECHAT_BACKEND_URL ||
  `http://localhost:${process.env.THECHAT_BACKEND_PORT || "3000"}`;

async function login(email, password) {
  const sidebarLogin = await $("button*=Log in");
  await sidebarLogin.waitForClickable({ timeout: 10_000 });
  await sidebarLogin.click();
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

describe("Cross-workspace unread activity", function () {
  this.timeout(180_000);

  it("surfaces an unread inactive workspace before it is selected", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const password = "password123";
    const ownerName = "E2E Unread Owner";
    const ownerEmail = `e2e-unread-owner-${suffix}@e2e.local`;
    const senderEmail = `e2e-unread-sender-${suffix}@e2e.local`;
    const alphaName = `Unread Alpha ${suffix}`;
    const betaName = `Unread Beta ${suffix}`;

    await browser.waitUntil(
      async () =>
        browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15_000, timeoutMsg: "React never mounted into #root" },
    );

    const setup = await browser.execute(
      async (
        apiUrl,
        password,
        ownerName,
        ownerEmail,
        senderEmail,
        alphaName,
        betaName,
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

        const owner = await register(ownerName, ownerEmail);
        const sender = await register("E2E Unread Sender", senderEmail);
        const auth = (token) => ({
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        });
        const workspaceAlpha = await jsonFetch("/workspaces/create", {
          method: "POST",
          headers: auth(owner.token),
          body: JSON.stringify({ name: alphaName }),
        });
        const workspaceBeta = await jsonFetch("/workspaces/create", {
          method: "POST",
          headers: auth(owner.token),
          body: JSON.stringify({ name: betaName }),
        });
        const invite = await jsonFetch("/invites/create", {
          method: "POST",
          headers: auth(owner.token),
          body: JSON.stringify({
            workspaceId: workspaceBeta.id,
            email: senderEmail,
          }),
        });
        await jsonFetch("/invites/accept", {
          method: "POST",
          headers: auth(sender.token),
          body: JSON.stringify({ inviteId: invite.id }),
        });
        const betaDetails = await jsonFetch(
          `/workspaces/${workspaceBeta.id}`,
          { headers: auth(sender.token) },
        );
        const betaGeneral = betaDetails.channels?.[0];
        if (!betaGeneral?.id) {
          throw new Error("Workspace Beta did not contain a General channel");
        }

        return {
          owner,
          sender,
          workspaceAlpha,
          workspaceBeta,
          betaGeneral,
        };
      },
      API_URL,
      password,
      ownerName,
      ownerEmail,
      senderEmail,
      alphaName,
      betaName,
    );

    await login(ownerEmail, password);

    const selectWorkspace = await $("button*=Select workspace");
    await selectWorkspace.waitForClickable({ timeout: 10_000 });
    await selectWorkspace.click();
    const alphaButton = await $(`button*=${setup.workspaceAlpha.name}`);
    await alphaButton.waitForClickable({ timeout: 10_000 });
    await alphaButton.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (name) =>
            document
              .querySelector('button[aria-label="Current workspace"]')
              ?.getAttribute("title") === name,
          setup.workspaceAlpha.name,
        ),
      {
        timeout: 15_000,
        timeoutMsg: "Workspace Alpha never became active",
      },
    );

    const badge = await $("[data-testid='other-workspace-unread-count']");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sent = await browser.execute(
        async (apiUrl, token, conversationId, attemptNumber) => {
          const response = await fetch(`${apiUrl}/messages/${conversationId}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              content: `Unread message attempt ${attemptNumber + 1}`,
            }),
          });
          return { ok: response.ok, status: response.status };
        },
        API_URL,
        setup.sender.token,
        setup.betaGeneral.id,
        attempt,
      );
      if (!sent.ok) {
        throw new Error(`Sending the Beta message failed: ${JSON.stringify(sent)}`);
      }
      try {
        await badge.waitForExist({ timeout: 5_000 });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }

    expect(await badge.getText()).toBe("1");
    const workspaceButton = await $(
      'button[aria-label="Current workspace, 1 other workspace with unread messages"]',
    );
    await workspaceButton.waitForClickable({ timeout: 10_000 });
    await workspaceButton.click();

    const betaUnreadButton = await $(
      `button[aria-label="${setup.workspaceBeta.name}, unread messages"]`,
    );
    await betaUnreadButton.waitForExist({ timeout: 10_000 });
    const betaIndicator = await $(
      `[data-testid="workspace-unread-indicator-${setup.workspaceBeta.id}"]`,
    );
    await betaIndicator.waitForExist({ timeout: 10_000 });
    await browser.waitUntil(
      async () =>
        browser.execute((workspaceId) => {
          const indicator = document.querySelector(
            `[data-testid="workspace-unread-indicator-${workspaceId}"]`,
          );
          const menu = indicator?.closest("div.absolute");
          return menu instanceof HTMLElement && getComputedStyle(menu).opacity === "1";
        }, setup.workspaceBeta.id),
      {
        timeout: 5_000,
        timeoutMsg: "Workspace switcher animation did not become fully opaque",
      },
    );

    const screenshotPath = process.env.THECHAT_WORKSPACE_UNREAD_SCREENSHOT;
    if (screenshotPath) {
      await browser.saveScreenshot(screenshotPath);
    }

    const indicatorVisual = await browser.execute(
      (workspaceId) => {
        const element = document.querySelector(
          `[data-testid="workspace-unread-indicator-${workspaceId}"]`,
        );
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const button = element.closest("button");
        const buttonRect = button?.getBoundingClientRect();
        const rowPoints = buttonRect
          ? [buttonRect.left + 8, buttonRect.left + buttonRect.width / 2, buttonRect.right - 8]
              .map((x) =>
                document.elementFromPoint(x, buttonRect.top + buttonRect.height / 2),
              )
          : [];
        return {
          width: rect.width,
          height: rect.height,
          backgroundColor: style.backgroundColor,
          opacity: style.opacity,
          visibility: style.visibility,
          ownsEntireRow:
            button !== null &&
            rowPoints.length === 3 &&
            rowPoints.every(
              (topElement) =>
                topElement !== null &&
                (topElement === button || button.contains(topElement)),
            ),
          topElementLabels: rowPoints.map(
            (topElement) =>
              topElement?.getAttribute("aria-label") ??
              topElement?.textContent?.trim() ??
              null,
          ),
        };
      },
      setup.workspaceBeta.id,
    );
    expect(indicatorVisual).not.toBeNull();
    expect(indicatorVisual.width).toBeGreaterThanOrEqual(7);
    expect(indicatorVisual.height).toBeGreaterThanOrEqual(7);
    expect(indicatorVisual.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(indicatorVisual.opacity).toBe("1");
    expect(indicatorVisual.visibility).toBe("visible");
    expect(indicatorVisual.ownsEntireRow).toBe(true);

    await betaUnreadButton.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (name) =>
            document
              .querySelector('button[aria-label="Current workspace"]')
              ?.getAttribute("title") === name,
          setup.workspaceBeta.name,
        ),
      {
        timeout: 15_000,
        timeoutMsg: "Workspace Beta never became active",
      },
    );
    const betaChannel = await $(`button[data-channel-id="${setup.betaGeneral.id}"]`);
    await betaChannel.waitForExist({ timeout: 10_000 });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (channelId) =>
            Boolean(
              document.querySelector(
                `button[data-channel-id="${channelId}"] .bg-accent`,
              ),
            ),
          setup.betaGeneral.id,
        ),
      {
        timeout: 10_000,
        timeoutMsg: "Workspace Beta's General channel was not marked unread",
      },
    );

    await betaChannel.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (channelId) =>
            !document.querySelector(
              `button[data-channel-id="${channelId}"] .bg-accent`,
            ),
          setup.betaGeneral.id,
        ),
      {
        timeout: 10_000,
        timeoutMsg: "Opening Workspace Beta's General channel did not clear unread",
      },
    );

    await logout(ownerName);
  });
});
