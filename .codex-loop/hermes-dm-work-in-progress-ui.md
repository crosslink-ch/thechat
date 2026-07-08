# Improve Hermes DM Work-In-Progress UI

## Goal

Improve the Hermes DM "work in progress" and tool-output activity UI so it
feels integrated with the chat transcript instead of like a separate boxed
panel. This applies to the inline Hermes activity shown after a user sends a
message to a Hermes DM and while Hermes is working, using tools, reasoning, or
waiting for approval.

## Current Problems

- The live activity block feels visually distinct from the chat because it is
  inside a prominent box with a separate background.
- Tool output, reasoning, notices, and approval states should read as part of
  the conversation timeline rather than as a detached widget.
- The "Context" footer at the bottom of the progress block is unnecessary and
  should be removed.

## Acceptance Criteria

- Hermes work-in-progress UI is visually integrated into the DM transcript.
- The progress/activity area no longer uses a prominent enclosing card/box that
  separates it from surrounding messages.
- Background, borders, spacing, and typography feel consistent with adjacent DM
  messages and the existing dark app theme.
- The "Context" footer/progress bar/details control is removed from the Hermes
  inline progress UI.
- Tool started/completed rows, reasoning rows, notice rows, queued/running
  states, and approval states remain understandable and scannable.
- Pending approvals remain clearly actionable and retain working decision
  buttons.
- Expanded tool/reasoning details remain readable without creating a large
  detached panel.
- The design works in the Hermes debug route and in the actual Hermes DM chat
  view.
- The implementation stays focused on Hermes DM progress/activity UI.

## Verification Expectations

- Run relevant automated tests for Hermes progress and DM chat UI, including
  `pnpm --filter @thechat/desktop test:unit` if practical.
- Run `pnpm --filter @thechat/desktop build`.
- Search for the removed "Context" footer text in Hermes progress UI code and
  rendered tests.
- Start the desktop web UI with Vite when practical and visually verify
  `/debug/hermes`.
- Use the Hermes debug route controls to verify at least these visual states:
  `Working`, `Queued`, `Tool started`, `Tool completed`, `Reasoning`,
  `Notice info`, `Notice warn`, `Notice error`, `Approval`, and `2 approvals`.
- Capture screenshots for the core before/after-relevant states under the loop
  run directory.
- Inspect at least one narrower viewport if practical to catch wrapping or
  spacing problems.
- Fail verification if the UI still looks like a distinct card/box, if the
  Context footer remains, or if approval actions regress.

## Useful Files And Routes

- Hermes debug route: `packages/desktop/src/routes/hermes-debug.tsx`
- Route path: `/debug/hermes`
- Main inline progress component:
  `packages/desktop/src/components/HermesProgressInline.tsx`
- Hermes DM shell:
  `packages/desktop/src/components/HermesDmChatView.tsx`
- Existing tests:
  `packages/desktop/src/components/HermesProgressInline.test.tsx`
  `packages/desktop/src/components/HermesDmChatView.test.tsx`
  `packages/desktop/src/routes/scroll-debug.test.tsx`

## Non-Goals

- Do not change Hermes runtime behavior, event schemas, queueing, approvals
  semantics, or bot invocation data flow.
- Do not redesign the whole DM screen, sidebar, command palette, or global app
  theme.
- Do not remove tool/reasoning/notice/approval information; improve how it is
  presented.
- Do not depend on a live Hermes Gateway for verification; use the debug route
  and mocked/simulated state.

