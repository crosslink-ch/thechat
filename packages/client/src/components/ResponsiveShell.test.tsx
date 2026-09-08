import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsiveShell, NavigationToggle } from "./ResponsiveShell";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mobileViewport() {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
}

it("dismisses navigation when the route changes", async () => {
  mobileViewport();
  const user = userEvent.setup();
  const view = (routeKey: string) => <ResponsiveShell navigation={<button>Channel</button>} routeKey={routeKey}><NavigationToggle /></ResponsiveShell>;
  const { rerender } = render(view("/channel/one"));
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  rerender(view("/channel/two"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("dismisses on browser Back without replacing the router's history state", async () => {
  mobileViewport();
  const user = userEvent.setup();
  render(<ResponsiveShell navigation={<button>Channel</button>} routeKey="one"><NavigationToggle /></ResponsiveShell>);
  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("opens a labelled modal navigation with focus containment and restores trigger focus", async () => {
  mobileViewport();
  const user = userEvent.setup();
  render(<ResponsiveShell navigation={<button>General channel</button>} routeKey="/channel/general">
    <NavigationToggle /><button>Composer</button>
  </ResponsiveShell>);
  expect(screen.queryByRole("button", { name: "General channel" })).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});
