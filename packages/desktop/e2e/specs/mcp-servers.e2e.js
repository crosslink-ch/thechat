// E2E test for MCP server management.
//
// Verifies that MCP servers can be added through the config dialog
// (both HTTP and Stdio transports), appear in the settings page with
// correct type badges, and can be disabled, enabled, and removed.
//
// The test uses URLs/commands that won't connect to a real MCP server,
// so initialization will fail — but the config is saved before
// initialization is attempted, which is the behavior we want to verify.
// The focus is on the UI and config persistence, not MCP protocol.

describe("MCP server management", function () {
  this.timeout(120_000);

  it("can add, disable, enable, and remove MCP servers through the UI", async () => {
    const HTTP_SERVER = "e2e-http";
    const HTTP_URL = "http://127.0.0.1:19876/mcp";
    const STDIO_SERVER = "e2e-stdio";
    const STDIO_COMMAND = "echo";
    const STDIO_ARGS = "hello";

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

    // ──────────────────────────────────────────────────────
    // Phase 1: Add an HTTP MCP server via the dialog
    // ──────────────────────────────────────────────────────

    let addBtn = await $("button*=+ Add Server");
    await addBtn.waitForClickable({ timeout: 5000 });
    await addBtn.click();

    let nameInput = await $("#mcp-name");
    await nameInput.waitForExist({ timeout: 5000 });
    await nameInput.setValue(HTTP_SERVER);

    const urlInput = await $("#mcp-url");
    await urlInput.waitForExist({ timeout: 3000 });
    await urlInput.setValue(HTTP_URL);

    let submitBtn = await $("button[type='submit']");
    await submitBtn.click();

    // Wait for initialization to resolve (expect failure — no real server).
    // Config is saved before initialization, so even on failure the server
    // persists in config.json.
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const modal = document.querySelector(".fixed.inset-0.z-20");
          if (!modal) return true; // Dialog closed = success
          return !!modal.querySelector(".bg-error-msg-bg"); // Error shown
        }),
      {
        timeout: 30000,
        timeoutMsg: "HTTP server: dialog neither closed nor errored",
      },
    );

    // Close dialog if still open (expected when init fails)
    let dialogOpen = await browser.execute(
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

    // ──────────────────────────────────────────────────────
    // Phase 2: Add a Stdio MCP server via the dialog
    // ──────────────────────────────────────────────────────

    addBtn = await $("button*=+ Add Server");
    await addBtn.waitForClickable({ timeout: 5000 });
    await addBtn.click();

    nameInput = await $("#mcp-name");
    await nameInput.waitForExist({ timeout: 5000 });
    await nameInput.setValue(STDIO_SERVER);

    // Switch to Stdio transport
    const stdioBtn = await $("button=Stdio");
    await stdioBtn.waitForClickable({ timeout: 3000 });
    await stdioBtn.click();

    const cmdInput = await $("#mcp-command");
    await cmdInput.waitForExist({ timeout: 3000 });
    await cmdInput.setValue(STDIO_COMMAND);

    const argsInput = await $("#mcp-args");
    await argsInput.setValue(STDIO_ARGS);

    submitBtn = await $("button[type='submit']");
    await submitBtn.click();

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const modal = document.querySelector(".fixed.inset-0.z-20");
          if (!modal) return true;
          return !!modal.querySelector(".bg-error-msg-bg");
        }),
      {
        timeout: 30000,
        timeoutMsg: "Stdio server: dialog neither closed nor errored",
      },
    );

    dialogOpen = await browser.execute(
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

    // ──────────────────────────────────────────────────────
    // Phase 3: Verify both servers appear in settings
    // ──────────────────────────────────────────────────────

    // Servers should appear immediately — no re-navigation needed.

    // Wait for HTTP server row
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (n) => !!document.querySelector(`[data-testid="mcp-server-${n}"]`),
          HTTP_SERVER,
        ),
      { timeout: 10000, timeoutMsg: `"${HTTP_SERVER}" never appeared` },
    );

    // Wait for Stdio server row
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (n) => !!document.querySelector(`[data-testid="mcp-server-${n}"]`),
          STDIO_SERVER,
        ),
      { timeout: 5000, timeoutMsg: `"${STDIO_SERVER}" never appeared` },
    );

    // Verify HTTP badge
    const httpBadge = await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      if (!row) return false;
      return !!Array.from(row.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === "HTTP",
      );
    }, HTTP_SERVER);
    expect(httpBadge).toBe(true);

    // Verify Stdio badge
    const stdioBadge = await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      if (!row) return false;
      return !!Array.from(row.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === "Stdio",
      );
    }, STDIO_SERVER);
    expect(stdioBadge).toBe(true);

    // ──────────────────────────────────────────────────────
    // Phase 4: Disable the HTTP server
    // ──────────────────────────────────────────────────────

    await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Disable",
      );
      btn?.click();
    }, HTTP_SERVER);

    // Verify "Disabled" badge appears
    await browser.waitUntil(
      async () =>
        await browser.execute((n) => {
          const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
          if (!row) return false;
          return !!Array.from(row.querySelectorAll("span")).find(
            (s) => s.textContent?.trim() === "Disabled",
          );
        }, HTTP_SERVER),
      { timeout: 5000, timeoutMsg: "'Disabled' badge never appeared" },
    );

    // Verify toggle button now says "Enable"
    let toggleText = await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => ["Enable", "Disable"].includes(b.textContent?.trim()),
      );
      return btn?.textContent?.trim();
    }, HTTP_SERVER);
    expect(toggleText).toBe("Enable");

    // ──────────────────────────────────────────────────────
    // Phase 5: Re-enable the HTTP server
    // ──────────────────────────────────────────────────────

    await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Enable",
      );
      btn?.click();
    }, HTTP_SERVER);

    // Verify "Disabled" badge disappears
    await browser.waitUntil(
      async () =>
        await browser.execute((n) => {
          const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
          if (!row) return false;
          return !Array.from(row.querySelectorAll("span")).find(
            (s) => s.textContent?.trim() === "Disabled",
          );
        }, HTTP_SERVER),
      { timeout: 5000, timeoutMsg: "'Disabled' badge didn't disappear" },
    );

    toggleText = await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => ["Enable", "Disable"].includes(b.textContent?.trim()),
      );
      return btn?.textContent?.trim();
    }, HTTP_SERVER);
    expect(toggleText).toBe("Disable");

    // ──────────────────────────────────────────────────────
    // Phase 6: Remove the Stdio server (with confirmation)
    // ──────────────────────────────────────────────────────

    // Click "Remove" — triggers two-step confirmation
    await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Remove",
      );
      btn?.click();
    }, STDIO_SERVER);

    // Wait for "Confirm" button to appear
    await browser.waitUntil(
      async () =>
        await browser.execute((n) => {
          const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
          if (!row) return false;
          return !!Array.from(row.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Confirm",
          );
        }, STDIO_SERVER),
      { timeout: 5000, timeoutMsg: "Confirm button never appeared" },
    );

    // Click "Confirm"
    await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Confirm",
      );
      btn?.click();
    }, STDIO_SERVER);

    // Verify Stdio server row disappears
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (n) => !document.querySelector(`[data-testid="mcp-server-${n}"]`),
          STDIO_SERVER,
        ),
      { timeout: 5000, timeoutMsg: "Stdio server row didn't disappear" },
    );

    // HTTP server should still be present
    const httpStillThere = await browser.execute(
      (n) => !!document.querySelector(`[data-testid="mcp-server-${n}"]`),
      HTTP_SERVER,
    );
    expect(httpStillThere).toBe(true);
  });
});
