// E2E test: Adding an MCP server via the config dialog should
// immediately show it in the settings list — no page re-navigation
// required.
//
// This test targets a specific bug where McpConfigDialog saved the
// config to disk but never notified the SettingsRoute component,
// so the new server only appeared after restarting the app.

describe("MCP server appears immediately after adding", function () {
  this.timeout(120_000);

  it("shows new HTTP server in settings list without re-navigating", async () => {
    const SERVER_NAME = "e2e-immediate";
    const SERVER_URL = "http://127.0.0.1:19999/mcp";

    // ── Wait for the app to boot ──
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15000, timeoutMsg: "React never mounted children into #root" },
    );

    // ── Navigate to Settings ──
    await browser.execute(() => {
      window.location.hash = "#/settings";
    });

    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => document.body.textContent?.includes("MCP Servers") ?? false,
        ),
      { timeout: 10000, timeoutMsg: "MCP Servers section never appeared" },
    );

    // Verify server does NOT exist yet
    const existsBefore = await browser.execute(
      (n) => !!document.querySelector(`[data-testid="mcp-server-${n}"]`),
      SERVER_NAME,
    );
    expect(existsBefore).toBe(false);

    // ── Open the Add Server dialog ──
    const addBtn = await $("button*=+ Add Server");
    await addBtn.waitForClickable({ timeout: 5000 });
    await addBtn.click();

    // ── Fill in server details ──
    const nameInput = await $("#mcp-name");
    await nameInput.waitForExist({ timeout: 5000 });
    await nameInput.setValue(SERVER_NAME);

    const urlInput = await $("#mcp-url");
    await urlInput.waitForExist({ timeout: 3000 });
    await urlInput.setValue(SERVER_URL);

    // ── Submit ──
    const submitBtn = await $("button[type='submit']");
    await submitBtn.click();

    // Wait for initialization to resolve (will fail — no real server).
    // Config is saved before initialization is attempted.
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const modal = document.querySelector(".fixed.inset-0.z-20");
          if (!modal) return true; // Dialog closed = success
          return !!modal.querySelector(".bg-error-msg-bg"); // Error shown
        }),
      {
        timeout: 30000,
        timeoutMsg: "Dialog neither closed nor errored after submit",
      },
    );

    // Close dialog if still open (expected when init fails)
    const dialogOpen = await browser.execute(
      () => !!document.querySelector(".fixed.inset-0.z-20"),
    );
    if (dialogOpen) {
      await browser.keys("Escape");
      await browser.waitUntil(
        async () =>
          !(await browser.execute(
            () => !!document.querySelector(".fixed.inset-0.z-20"),
          )),
        { timeout: 5000, timeoutMsg: "Dialog didn't close after Escape" },
      );
    }

    // ── KEY ASSERTION: server should appear immediately ──
    // Do NOT re-navigate — this is the bug we're testing.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (n) => !!document.querySelector(`[data-testid="mcp-server-${n}"]`),
          SERVER_NAME,
        ),
      {
        timeout: 5000,
        timeoutMsg:
          `"${SERVER_NAME}" did not appear in settings list immediately after adding — ` +
          "the McpConfigDialog may not be notifying the SettingsRoute of the config change",
      },
    );

    // Verify it has the HTTP badge
    const hasHttpBadge = await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      if (!row) return false;
      return !!Array.from(row.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === "HTTP",
      );
    }, SERVER_NAME);
    expect(hasHttpBadge).toBe(true);

    // Verify the URL is shown
    const hasUrl = await browser.execute(
      (n, url) => {
        const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
        return row?.textContent?.includes(url) ?? false;
      },
      SERVER_NAME,
      SERVER_URL,
    );
    expect(hasUrl).toBe(true);
  });
});
