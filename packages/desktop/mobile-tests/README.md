# Mobile shell integration (client/root owner)

No startup, auth, API, package or lockfile changes in this lane. `routes/__root.tsx` is untouched.

1. Import `AppViewport` from `../components/AppViewport` and replace the outer RootView `<div ...h-screen...>` with `<AppViewport className="relative flex flex-col bg-base">`. Keep the titlebar/auth/overlays inside it. Mount **once**, including logged-out views. It uses `100dvh` with a mobile VisualViewport keyboard-height/offset fallback and leaves pinch zoom alone.
2. Import `ResponsiveShell` from `../components/ResponsiveShell`. Replace only the authenticated flex-row/Sidebar/content wrapper:

```tsx
const routeKey = useRouterState({ select: state => state.location.href });
// In an unconditional hook position in RootView or a tiny authenticated shell component.
<ResponsiveShell navigation={<Sidebar />} routeKey={routeKey}>
  <ChatHeader />
  <ErrorBoundary name="Route"><Outlet /></ErrorBoundary>
</ResponsiveShell>
```

`ChatHeader` renders its toggle from shell context. Do not keep the old extra content flex-column wrapper; the shell provides it. Keep CommandPalette/dialogs outside the shell, as today.

3. Web viewport meta: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` (do **not** disable zoom).

Accessible labels: `Open navigation`, `Close navigation`; dialog **and nav landmark** `Workspace navigation`. Mobile nav applies below 1024px. Close/outside/Escape restore trigger focus. Any Sidebar route selection closes immediately, including the same channel. Browser Back closes navigation and follows the router's normal history; **no synthetic entries are pushed**. Profile/Log out remains the existing Sidebar UI.

Hermes tasks now expose `Open tasks and activity`, `Close tasks and activity`, dialog `Tasks and activity` below 1280px, with `New task` and all existing General/task/activity rows. Selecting General/task/New closes the panel. The `shared-dm-layout` JSX class in `routes/dm.tsx` stacks this toolbar before chat on narrow screens. No runtime/auth change there.

The workspace dialog now uses the existing Radix Dialog dependency, with `Close workspace dialog`; channel/bot dialogs retain their existing implementation. Shared mobile CSS constrains dialog height/width, raises touch targets, and keeps the rich composer/attachments reachable. Textbox name: `Message`.

Fixture evidence is synthetic store/components only (including synthetic approval/question callbacks, local image attachment selection); it is NOT auth/network/upload/bot E2E. Parent still owns real browser journeys, channel/DM backend selection, server upload and integrated authentication acceptance.

## Repeatable component-browser acceptance

`mobile.pw.mjs` intentionally uses a non-Vitest filename, so the native unit suite does not load Playwright. It drives the actual shared components with synthetic stores and explicit callbacks, in Chromium and WebKit, at 320/390/768/1440px plus short heights. The Vite fixture registers the real Tailwind v4 source tree; it is not a hand-built CSS facsimile.

From the repository root (with the parent-installed `@playwright/test`):

```sh
MOBILE_ARTIFACTS_DIR=/workspace/thechat-web-runtime/mobile/verified \
PLAYWRIGHT_BROWSERS_PATH=/workspace/thechat-web-runtime/browsers \
pnpm exec playwright test --config packages/desktop/mobile-tests/playwright.config.mjs
```

During isolated worktree development, set `MOBILE_PLAYWRIGHT_ROOT=/workspace/thechat` and invoke `/workspace/thechat/node_modules/@playwright/test/cli.js` with Node instead. No additional dependencies or lockfile edits are needed in this lane. The fixture uses loopback port 1433 only; caches, reports, traces and screenshots are written outside the repository. Desktop frontend typecheck/build and the complete native unit suite are separate checks.
