// E2E test for the workspace shared-configuration feature.
//
// Verifies that when a user enables "inherit from workspace" in local
// Settings, a chat message is sent successfully using credentials and a
// model that live ONLY in the workspace config (never in local config).
// If inheritance is broken, the local config has no API key and the chat
// would fail with an auth error — so a successful assistant response is
// strong evidence that the workspace → local config merge is working.
//
// Setup is done via the API (faster, less brittle than clicking through the
// workspace-manage UI). The actual feature exercise (login → enable
// inheritance → send chat) goes through the real UI.

const API_URL = "http://localhost:3000";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY env var is required — set it in .env");
}
const MODEL = "qwen/qwen3.5-35b-a3b";

describe("Workspace shared config", function () {
  // OpenRouter + a reasoning model can take a while; raise the per-test
  // timeout above the wdio.conf.js default (60s) so a slow stream doesn't
  // get killed by mocha before our own waitUntil deadlines fire.
  this.timeout(180_000);

  it("uses workspace OpenRouter credentials when local settings inherit from workspace", async () => {
    const email = `e2e-shared-cfg-${Date.now()}@e2e.local`;
    const password = "password123";
    const wsName = `E2E WS ${Date.now()}`;

    // ── Wait for the app to boot ──
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15000, timeoutMsg: "React never mounted children into #root" },
    );

    // ── Phase 1: Set up account + workspace + workspace config via API ──
    // Done via fetch from inside the webview so it shares the same network
    // path the app itself uses.
    const setup = await browser.execute(
      async (apiUrl, email, password, wsName, apiKey, model) => {
        async function jsonFetch(url, init) {
          const res = await fetch(url, init);
          const text = await res.text();
          let body;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          return { ok: res.ok, status: res.status, body };
        }

        // Register
        const reg = await jsonFetch(`${apiUrl}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "E2E Test User", email, password }),
        });
        if (!reg.ok) {
          return { error: `register: ${reg.status} ${JSON.stringify(reg.body)}` };
        }
        const token = reg.body?.accessToken;
        if (!token) {
          return { error: `register returned no accessToken: ${JSON.stringify(reg.body)}` };
        }

        // Create workspace
        const ws = await jsonFetch(`${apiUrl}/workspaces/create`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ name: wsName }),
        });
        if (!ws.ok) {
          return { error: `create workspace: ${ws.status} ${JSON.stringify(ws.body)}` };
        }
        const wsId = ws.body?.id;
        if (!wsId) {
          return { error: `create workspace returned no id: ${JSON.stringify(ws.body)}` };
        }

        // Set OpenRouter API key on the workspace
        const orRes = await jsonFetch(
          `${apiUrl}/workspaces/${wsId}/config/openrouter`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ apiKey }),
          },
        );
        if (!orRes.ok) {
          return {
            error: `set openrouter: ${orRes.status} ${JSON.stringify(orRes.body)}`,
          };
        }

        // Set model + low reasoning effort on the workspace
        const stRes = await jsonFetch(
          `${apiUrl}/workspaces/${wsId}/config/settings`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              openrouterModel: model,
              reasoningEffort: "low",
            }),
          },
        );
        if (!stRes.ok) {
          return { error: `set settings: ${stRes.status} ${JSON.stringify(stRes.body)}` };
        }

        // Set active provider to openrouter (defensive — should already be set
        // by setOpenRouterConfig, but explicit is better)
        const provRes = await jsonFetch(
          `${apiUrl}/workspaces/${wsId}/config/provider`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ provider: "openrouter" }),
          },
        );
        if (!provRes.ok) {
          return {
            error: `set provider: ${provRes.status} ${JSON.stringify(provRes.body)}`,
          };
        }

        return { wsId };
      },
      API_URL,
      email,
      password,
      wsName,
      OPENROUTER_API_KEY,
      MODEL,
    );

    if (setup.error) {
      throw new Error(`API setup failed: ${setup.error}`);
    }
    const wsId = setup.wsId;

    // ── Phase 2: Log in via the auth modal so Tauri kv stores the tokens ──
    // The "Log in" button in the sidebar footer is the only one before auth.
    const sidebarLoginBtn = await $("button*=Log in");
    await sidebarLoginBtn.waitForClickable({ timeout: 10000 });
    await sidebarLoginBtn.click();

    const emailInput = await $("#auth-email");
    await emailInput.waitForExist({ timeout: 5000 });
    await emailInput.setValue(email);

    const passwordInput = await $("#auth-password");
    await passwordInput.setValue(password);

    // Submit the auth form (the only submit button on the page is the modal's)
    const authSubmitBtn = await $("button[type='submit']");
    await authSubmitBtn.click();

    // Modal closes when login succeeds
    await emailInput.waitForExist({ reverse: true, timeout: 10000 });

    // ── Phase 3: Enable workspace inheritance in Settings ──
    // Use the hash router directly — clicking through the profile menu would
    // add brittle steps that aren't part of what we're testing.
    await browser.execute(() => {
      window.location.hash = "#/settings";
    });

    // The inheritance <select> only renders once the workspaces store has
    // populated (token + workspaces.length > 0). Wait for an option that
    // matches our newly-created workspace.
    const inheritSelect = await $("select");
    await inheritSelect.waitForExist({ timeout: 10000 });
    await browser.waitUntil(
      async () => {
        const opts = await inheritSelect.$$("option");
        for (const opt of opts) {
          const v = await opt.getAttribute("value");
          if (v === wsId) return true;
        }
        return false;
      },
      {
        timeout: 10000,
        timeoutMsg: `Workspace ${wsId} never appeared in inherit dropdown`,
      },
    );

    // Set the select value via the React-friendly path. WDIO's selectByAttribute
    // clicks the <option>, which fires events on the option but not always a
    // change event on the <select> in WebKit, so React's onChange may never run.
    // Use the native value setter + dispatch a bubbling change event so React's
    // synthetic event system picks it up.
    const selectedOk = await browser.execute((wsId) => {
      const select = document.querySelector("select");
      if (!select) return { ok: false, reason: "no select" };
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      ).set;
      setter.call(select, wsId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: select.value === wsId, value: select.value };
    }, wsId);
    if (!selectedOk.ok) {
      throw new Error(
        `Failed to set inherit workspace select: ${JSON.stringify(selectedOk)}`,
      );
    }

    // The Settings page has a button labeled exactly "Save".
    const saveBtn = await $("button=Save");
    await saveBtn.waitForClickable({ timeout: 5000 });
    await saveBtn.click();

    // The "Settings saved" status text appears once save completes.
    await $("span=Settings saved").waitForExist({ timeout: 5000 });

    // ── Phase 4: Send a chat message that exercises the inherited config ──
    await browser.execute(() => {
      window.location.hash = "#/chat";
    });

    const editor = await $('[contenteditable="true"]');
    await editor.waitForExist({ timeout: 10000 });
    await editor.click();

    // execCommand is the most reliable way to insert text into a TipTap /
    // ProseMirror contentEditable from WebDriver. ProseMirror handles the
    // resulting input event and updates its document model.
    await browser.execute(() => {
      document.execCommand(
        "insertText",
        false,
        "Reply with exactly the word: pong",
      );
    });

    // Press Enter — the RichInput "submitOnEnter" extension submits when
    // there is non-empty text.
    await browser.keys("Enter");

    // ── Phase 5: Wait for the streamed response to fully complete ──
    // Detection strategy:
    //   - Once useChat finishes streaming, the assistant message is persisted
    //     to the messages array and rendered by ChatMessage (line 575). That
    //     component renders a ThinkingSection with `data-testid="thinking-section"`
    //     when there is reasoning or tool calls. The StreamingMessage component
    //     uses a different reasoning block that does NOT carry that testid, so
    //     `[data-testid="thinking-section"]` is a clean signal that the
    //     persisted message has rendered.
    //   - The chat error block on the agent route is uniquely identified by
    //     BOTH `bg-error-msg-bg` AND `text-error-bright` together. (The
    //     InputBar Stop button has only `text-error-bright`, so the combined
    //     selector won't match it. No modal is open here, so this is
    //     unambiguous to the chat error.)
    //   - We extract the actual model text from the markdown render area,
    //     skipping the "Assistant" header and the collapsed thinking-section
    //     button label, so we can verify the model actually produced an
    //     answer (not just reasoning).
    let snapshot;
    await browser.waitUntil(
      async () => {
        snapshot = await browser.execute(() => {
          const errorBlock = document.querySelector(
            ".bg-error-msg-bg.text-error-bright",
          );
          if (errorBlock) {
            return {
              done: true,
              error: errorBlock.textContent?.trim() || "(empty error)",
            };
          }

          // Persisted ChatMessage signals streaming has fully completed.
          const thinking = document.querySelector(
            '[data-testid="thinking-section"]',
          );
          if (!thinking) return { done: false };

          const assistant = thinking.closest(
            '[data-testid="chat-message-assistant"]',
          );
          if (!assistant) return { done: false };

          // The persisted ChatMessage layout is:
          //   <div testid="chat-message-assistant">
          //     <div>Assistant</div>
          //     <div class="max-w-3xl">
          //       <div testid="thinking-section">...</div>
          //       <TextWithUiBlocks ... /> ← the actual model answer lives here
          //     </div>
          //   </div>
          // We grab .max-w-3xl, drop the thinking-section subtree, and read
          // what's left.
          const inner = assistant.querySelector(".max-w-3xl");
          if (!inner) return { done: false };
          const clone = inner.cloneNode(true);
          clone
            .querySelectorAll('[data-testid="thinking-section"]')
            .forEach((n) => n.remove());
          const answerText = clone.textContent?.trim() ?? "";
          return { done: true, answerText };
        });
        return snapshot.done;
      },
      {
        timeout: 90000,
        timeoutMsg:
          "Timed out waiting for chat response — persisted assistant message never rendered and no error appeared",
      },
    );

    if (snapshot.error) {
      throw new Error(`Chat surfaced an error: ${snapshot.error}`);
    }
    expect(snapshot.answerText.length).toBeGreaterThan(0);
  });
});
