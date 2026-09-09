# Browser layout regressions

These tests run the real chat views, composer and application CSS with synthetic
messages in Chromium and WebKit. They require no API, account, database or Tauri
IPC. Vite is started on an ephemeral loopback port and closed after the run.
They complement, rather than replace, the compiled Tauri E2E suite.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @thechat/web exec playwright install --with-deps chromium webkit
pnpm --filter @thechat/web test:browser
```

On persistent devboxes, set `PLAYWRIGHT_BROWSERS_PATH` to a directory outside the
checkout before both installation and testing.

`composer-scroll.browser.mjs` covers deletion of the final character using
Backspace, forward Delete and select-all deletion, in channel/human-DM and Hermes
chat views at desktop and narrow widths. It verifies that bottom-pinned history
stays pinned and that deliberately scrolled-up history is not forced downward.
Native editing and layout are essential: jsdom does not reproduce the temporary
empty-paragraph collapse and scroll clamping that this regression catches.
