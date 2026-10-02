# Browser layout regressions

These tests run the real chat views, composer and application CSS with synthetic
messages in Chromium and WebKit. They require no API, account, database or Tauri
IPC. Vite is started on an ephemeral loopback port and closed after the run.
They complement, rather than replace, the compiled Tauri E2E suite.

## Named pasted links: automated and hands-on

Run just the native clipboard regression from the repository root:

```sh
pnpm --filter @thechat/web exec node --test browser-tests/link-paste.browser.mjs
```

It uses native keyboard copy/paste in Chromium **and** WebKit (no constructed
ClipboardEvent or mocked editor), the actual shared InputBar, the actual draft
store and Markdown renderer. It asserts exact captured `onSend` content and
rendered `getAttribute('href')`, not normalized DOM `.href`. Transport alone is
local/synthetic: this does **not** prove API persistence or bot delivery.

For hands-on testing:

```sh
pnpm --filter @thechat/web exec vite --host 127.0.0.1 --port 1422 --strictPort
```

Open **http://127.0.0.1:1422/browser-tests/fixtures/link-paste.html**. On a remote
devbox, forward port 1422 over SSH first; no need to expose Vite publicly.

1. Select the visible **KGSP 18-140 I V.mp4** hyperlink text and use Ctrl+C
   (Cmd+C on macOS). Do not use **Copy link address**, a code-block Copy button,
   or plain-text paste: those test a different clipboard representation.
2. Click **Message**, use regular Ctrl+V, then click **Send message**.
3. Compare the captured `onSend` string with the rendered named link and the
   full expected destination displayed above the composer. The sample URL is
   `https://example.com/?file=KGSP%2018-140%20I%20V.mp4&e=Demo123&download=1#preview`.
   This is not a real video; there is no external send. Inspect the rendered
   anchor's `href` attribute if exact case/encoding parity is needed.
4. Paste again, click **Draft B**, type a different draft, and click **Draft A**.
   The restored draft may show raw `[label](url)` Markdown; both label and URL
   must survive. Type ` edited`, then press Enter. The URL must still render
   once, not as nested link syntax. Switch to B to check its separate draft.
5. Select and copy the **Plain URL control** text and send it. The captured
   string must stay the plain URL, without an added Markdown wrapper.

For before/after comparison, run this same dev-only fixture/test in a disposable
checkout at the PR base and at the candidate (copy only the new fixture/test
files to the base; leave its production RichInput unchanged). The base should
show a named link in the composer but capture only the filename; the candidate
must capture the destination too. Do not replace RichInput in an active checkout
or invoke a real conversation's transport to perform this comparison.

The HTML fixture is a Vite dev entry under `browser-tests`, not imported by the
production app or configured as a build entry. Existing fixtures are unchanged.

Scope/limitations: exports named HTTP(S) link marks, not arbitrary rich formatting
or file/FTP/relative/mailto links. Ordinary user Markdown is left literal; enclosing
handwritten code/math can intentionally suppress link rendering. A separating
space is inserted when a generated link immediately follows `!`, preventing an
accidental Markdown image. Pasted links with whitespace/control characters in
hrefs are left as labels; normal percent-encoded web URLs retain their original
encoding, query string and fragment. This is string draft preservation, not rich
draft persistence.

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
