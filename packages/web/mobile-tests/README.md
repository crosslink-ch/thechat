# Shared mobile UI acceptance

The production root composes `AppViewport` and `ResponsiveShell`. Authentication,
router ownership and platform startup remain in `routes/__root.tsx`.

- `AppViewport` surrounds authenticated and logged-out views. It uses dynamic
  viewport height, a VisualViewport keyboard-height/offset fallback, and does not
  relayout the page during pinch zoom.
- `ResponsiveShell` receives the actual route key and shared Sidebar. Below
  1024px it provides a Radix drawer, focus trapping/restoration, and accessible
  `Open navigation` / `Close navigation` controls. Selecting a sidebar route,
  including the current route, closes it. Browser Back follows normal history;
  no synthetic history entries are added.
- `ChatHeader` reads navigation context. Dialogs and the command palette remain
  outside the shell. `Workspace navigation` names both the drawer and nav.
- Below 900px Hermes tasks use the `Tasks and activity` drawer, with
  `Open tasks and activity`, `Close tasks and activity`, `New task`, and the
  existing General/task/activity rows. Selecting a row closes the panel.
- Mobile CSS constrains dialog dimensions, raises touch targets, and keeps the
  rich composer, attachments, reactions, approvals and questions reachable.
  The composer textbox is named `Message`. The workspace dialog uses Radix and
  exposes `Close workspace dialog`.

## Component-browser tests

```sh
# From the repository root, after installing the pinned dependencies/browsers:
pnpm exec playwright test --config packages/web/mobile-tests/playwright.config.mjs
```

The suite drives actual shared components in Chromium and WebKit at
320/390/768/1440px plus short heights. The Vite fixture explicitly registers the
production Tailwind source tree; it is not a CSS facsimile. Synthetic stores and
callbacks provide approval/question and local image-selection scenarios. This
is **component-browser evidence, not authentication, upload, network or LLM E2E**.
Use `pnpm test:e2e:web` for server-backed browser journeys; see
[the web runbook](../../../docs/web.md).

The fixture uses loopback port 1433 and refuses to reuse an existing server.
Artifacts and Vite cache default to `~/.cache/thechat/mobile-tests`;
`MOBILE_ARTIFACTS_DIR` overrides that directory. Use `PLAYWRIGHT_BROWSERS_PATH`
when browser binaries live in a separate persistent cache. During isolated
worktree development, `MOBILE_PLAYWRIGHT_ROOT` can point at another checkout's
installed Playwright package. No production credentials or data are required.
