import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WindowTitlebar } from "./WindowTitlebar";
import { ResponsiveShell } from "@thechat/client/components/ResponsiveShell";
import { ChatHeader } from "@thechat/client/components/ChatHeader";
import { useSidebarState } from "@thechat/client/components/Sidebar";

vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [{ fullPath: "/dm/$id", params: { id: "dm-1" } }],
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useSidebarState.setState({ open: true }); });

function viewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width <= Number(query.match(/max-width: (\d+)px/)![1]),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

it.each([1279, 1100, 1024, 390])("uses the functional drawer toggle instead of the titlebar sidebar control at %ipx", async width => {
  viewport(width);
  const user = userEvent.setup();
  render(<><WindowTitlebar /><ResponsiveShell navigation={<button>Channel</button>} routeKey="/dm/dm-1"><ChatHeader /></ResponsiveShell></>);
  expect(screen.queryByRole("button", { name: /^(Open|Collapse) sidebar$/ })).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Channel" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("keeps the titlebar sidebar control functional at 1280px", async () => {
  viewport(1280);
  const user = userEvent.setup();
  render(<WindowTitlebar />);
  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(useSidebarState.getState().open).toBe(false);
  await user.click(screen.getByRole("button", { name: "Open sidebar" }));
  expect(useSidebarState.getState().open).toBe(true);
});
