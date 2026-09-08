import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RootView } from "./__root";
import { openReleaseNotes, previewReleaseNotes, useReleaseNotesStore } from "../stores/release-notes";

vi.mock("../lib/release-notes", () => ({
  shippedReleaseVersion: "0.9.0",
  releaseNotesCatalog: [{ version: "0.9.0", title: "Activity", date: "2026-09-07", body: "Root release notes." }],
}));
vi.mock("#platform-shell", () => ({ PlatformDialogs: () => null, PlatformTitlebar: () => null, PlatformUpdateToast: () => null, usePlatformLifecycle: () => {} }));
vi.mock("@tanstack/react-router", () => ({ Outlet: () => <div>Conversation content</div>, useNavigate: () => vi.fn(), useRouterState: () => "/channel/a" }));
vi.mock("../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../components/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../components/AuthModal", () => ({ AuthModal: () => null, AuthOnboarding: () => <div>Log in</div> }));
vi.mock("../components/WorkspaceModal", () => ({ WorkspaceModal: () => null, openWorkspaceModal: vi.fn() }));
vi.mock("../components/ChannelModal", () => ({ ChannelModal: () => null }));
vi.mock("../components/HermesBotModal", () => ({ HermesBotModal: () => null }));

beforeEach(() => {
  vi.stubEnv("DEV", false);
  useReleaseNotesStore.setState({ request: null });
});
afterEach(() => vi.unstubAllEnvs());

it("does not automatically show release notes in a development build but keeps manual history usable", () => {
  vi.stubEnv("DEV", true);
  render(<RootView authLoading={false} authenticated userId="root-dev-user" />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => openReleaseNotes());
  expect(screen.getByText("Root release notes.")).toBeInTheDocument();
});

it("gates the installed prompt on resolved authentication, not just cached identity", async () => {
  const app = render(<RootView authLoading authenticated userId="root-user" />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  app.rerender(<RootView authLoading={false} authenticated={false} userId="root-user" />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  app.rerender(<RootView authLoading={false} authenticated userId="root-user" routeKey="/channel/a" />);
  expect(screen.getByText("Root release notes.")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  app.rerender(<RootView authLoading={false} authenticated userId="root-user" routeKey="/settings" />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each([true, false])("keeps an updater preview usable while signed out (auth loading=%s)", (authLoading) => {
  render(<RootView authLoading={authLoading} authenticated={false} />);
  act(() => previewReleaseNotes({ version: "0.9.0", body: "Available update details." }));
  expect(screen.getByRole("dialog", { name: "Update release notes" })).toBeInTheDocument();
  expect(screen.getByText("Available update details.")).toBeInTheDocument();
});
