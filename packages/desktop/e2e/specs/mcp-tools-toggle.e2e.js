// E2E test: MCP server tool availability.
//
// Verifies that:
//   1. Adding a real (stdio) MCP server populates the LLM's tool set.
//   2. Disabling that server removes its tools.
//   3. Re-enabling the server restores the tools.
//
// Uses a minimal fixture MCP server (e2e/fixtures/mcp-test-server.mjs)
// that implements the MCP protocol over stdio and exposes a single tool
// called "e2e_ping".

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = path.resolve(
  __dirname,
  "../fixtures/mcp-test-server.mjs",
);

describe("MCP tools toggle", function () {
  this.timeout(120_000);

  it("disabling an MCP server removes its tools; re-enabling restores them", async () => {
    const SERVER_NAME = "e2e-tools-test";
    const TOOL_NAME = `${SERVER_NAME}__e2e_ping`;

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
    // Phase 1: Add a Stdio MCP server via the dialog
    // ──────────────────────────��───────────────────────────

    const addBtn = await $("button*=+ Add Server");
    await addBtn.waitForClickable({ timeout: 5000 });
    await addBtn.click();

    const nameInput = await $("#mcp-name");
    await nameInput.waitForExist({ timeout: 5000 });
    await nameInput.setValue(SERVER_NAME);

    // Switch to Stdio transport
    const stdioBtn = await $("button=Stdio");
    await stdioBtn.waitForClickable({ timeout: 3000 });
    await stdioBtn.click();

    const cmdInput = await $("#mcp-command");
    await cmdInput.waitForExist({ timeout: 3000 });
    await cmdInput.setValue("node");

    const argsInput = await $("#mcp-args");
    await argsInput.setValue(MCP_SERVER_SCRIPT);

    const submitBtn = await $("button[type='submit']");
    await submitBtn.click();

    // Wait for initialization to complete — the dialog should close on
    // success (the fixture server responds correctly to the handshake).
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const modal = document.querySelector(".fixed.inset-0.z-20");
          if (!modal) return true; // Dialog closed = success
          return !!modal.querySelector(".bg-error-msg-bg"); // Error shown
        }),
      {
        timeout: 30000,
        timeoutMsg:
          "MCP dialog neither closed nor errored — " +
          "the fixture server may not be responding to the handshake",
      },
    );

    // If dialog is still open with an error, fail explicitly.
    const dialogStillOpen = await browser.execute(
      () => !!document.querySelector(".fixed.inset-0.z-20"),
    );
    if (dialogStillOpen) {
      const errorText = await browser.execute(() => {
        const el = document.querySelector(".bg-error-msg-bg");
        return el?.textContent ?? "(no error text)";
      });
      throw new Error(
        `MCP server initialization failed: ${errorText}. ` +
          `Fixture path: ${MCP_SERVER_SCRIPT}`,
      );
    }

    // ──────────────────────────────────────────────────────
    // Phase 2: Verify server appears in settings
    // ────��───────────────��─────────────────────────────────

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (n) => !!document.querySelector(`[data-testid="mcp-server-${n}"]`),
          SERVER_NAME,
        ),
      { timeout: 10000, timeoutMsg: `"${SERVER_NAME}" never appeared` },
    );

    // ──────────────────────────��───────────────────────────
    // Phase 3: Confirm the tool is available in the tools store
    // ───────────────────────────────────────────���──────────

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (toolName) =>
            window.__toolsStore
              ?.getState()
              .tools.some((t) => t.name === toolName) ?? false,
          TOOL_NAME,
        ),
      {
        timeout: 10000,
        timeoutMsg:
          `Tool "${TOOL_NAME}" never appeared in the tools store — ` +
          "MCP server may have connected but tools were not registered",
      },
    );

    // ─────────────────────────────────────────────────────���
    // Phase 4: Disable the MCP server
    // ──────────────────────────────────────────────────────

    await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Disable",
      );
      btn?.click();
    }, SERVER_NAME);

    // Verify "Disabled" badge appears
    await browser.waitUntil(
      async () =>
        await browser.execute((n) => {
          const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
          if (!row) return false;
          return !!Array.from(row.querySelectorAll("span")).find(
            (s) => s.textContent?.trim() === "Disabled",
          );
        }, SERVER_NAME),
      { timeout: 5000, timeoutMsg: "'Disabled' badge never appeared" },
    );

    // ──────────────────────────────────────────────────────
    // Phase 5: Confirm the tool is NO LONGER in the tools store
    // ─────────��──────────────────────────��─────────────────

    await browser.waitUntil(
      async () =>
        await browser.execute(
          (toolName) =>
            !(
              window.__toolsStore
                ?.getState()
                .tools.some((t) => t.name === toolName) ?? true
            ),
          TOOL_NAME,
        ),
      {
        timeout: 5000,
        timeoutMsg:
          `Tool "${TOOL_NAME}" was not removed from tools store after disabling — ` +
          "the toggle may not be calling removeGlobalMcpToolsByServer",
      },
    );

    // ────────────────────��─────────────────────────────────
    // Phase 6: Re-enable the server and verify tools return
    // ──────────────────────────────────────────────────────

    await browser.execute((n) => {
      const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
      const btn = Array.from(row.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Enable",
      );
      btn?.click();
    }, SERVER_NAME);

    // Verify "Disabled" badge disappears
    await browser.waitUntil(
      async () =>
        await browser.execute((n) => {
          const row = document.querySelector(`[data-testid="mcp-server-${n}"]`);
          if (!row) return false;
          return !Array.from(row.querySelectorAll("span")).find(
            (s) => s.textContent?.trim() === "Disabled",
          );
        }, SERVER_NAME),
      { timeout: 5000, timeoutMsg: "'Disabled' badge didn't disappear" },
    );

    // Verify tool is back in the store
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (toolName) =>
            window.__toolsStore
              ?.getState()
              .tools.some((t) => t.name === toolName) ?? false,
          TOOL_NAME,
        ),
      {
        timeout: 15000,
        timeoutMsg:
          `Tool "${TOOL_NAME}" did not reappear after re-enabling — ` +
          "the toggle may not be calling mcp_initialize_servers",
      },
    );
  });
});
