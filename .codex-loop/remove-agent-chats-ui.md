# Remove Agent Chats From UI

## Goal

Remove Agent Chats functionality from the user-facing UI while preserving the
underlying implementation code where practical. The app should lead with the
Workspace experience, and first-run desktop users should complete registration
onboarding before using the app.

## Acceptance Criteria

- Agent Chats are not reachable through visible navigation, command palette
  actions, menu items, keyboard shortcuts, empty states, or first-run flows.
- The command palette no longer exposes "New Chat" or equivalent Agent Chat
  creation actions.
- Workspace is the default/main view after the app is usable.
- First-run desktop users see onboarding that requires registration before the
  app can be used.
- Backend/service code that powers Agent Chats, file reading, workspace access,
  tool execution, or related non-UI behavior is not deleted merely to hide UI
  access.
- Any remaining internal Agent Chat code paths are inaccessible from the
  supported UI.
- Existing automated tests are updated only where they directly encode removed
  UI access.
- New or updated tests cover the changed UI behavior where practical.

## Verification Expectations

- Run relevant automated checks for the desktop UI and any touched packages.
- Search the codebase for UI-visible Agent Chat labels, route links, command
  palette entries, menu items, and shortcuts.
- Start the app when practical and verify visually that the Workspace experience
  is the primary view and Agent Chat creation is not accessible.
- Verify first-run/onboarding behavior where practical. If a full first-install
  simulation is not practical, document exactly what was checked and what risk
  remains.
- Fail verification if backend Agent Chat functionality was removed without a
  clear UI-only need.

## Non-Goals

- Do not delete Agent Chat backend/services merely because UI access is removed.
- Do not redesign unrelated Workspace workflows.
- Do not introduce a new auth provider or registration system unless the app
  already has the needed patterns or the implementation cannot meet the goal
  otherwise.

