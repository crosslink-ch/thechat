import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader";
import { HermesRuntimePanel } from "./HermesRuntimePanel";
import { ResponsiveShell } from "./ResponsiveShell";

vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [{ fullPath: "/dm/$id", params: { id: "dm-1" } }],
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("puts the Tasks trigger in the header and preserves approval naming, dialog scope and focus", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<ResponsiveShell navigation={<p>Channels</p>} routeKey="dm-1">
    <ChatHeader />
    <HermesRuntimePanel botName="Hermes" runtime={null} loading={false} generalNeedsApproval onSelectThread={onSelect} />
  </ResponsiveShell>);
  const header = within(screen.getByRole("banner", { name: "Conversation header" }));
  const trigger = header.getByRole("button", { name: /Open tasks and activity/ });
  expect(trigger).toHaveAccessibleName("Open tasks and activity · Needs approval");
  expect(trigger).toHaveTextContent("Tasks · Needs approval");
  expect(document.querySelector(".hermes-task-access")).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Tasks and activity" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /General/ }));
  expect(onSelect).toHaveBeenCalledWith(null);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});
