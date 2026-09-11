import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ResponsiveShell } from "./ResponsiveShell";
import { ChatHeader } from "./ChatHeader";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [{ fullPath: "/dm/$id", params: { id: "dm-1" } }],
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function viewport(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return width <= Number(query.match(/max-width: (\d+)px/)![1]); },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: number) => act(() => {
    width = next;
    [...listeners].forEach(listener => listener());
  });
}

it("collapses navigation before Tasks and restores both when widening", async () => {
  const resize = viewport(1440);
  const user = userEvent.setup();
  const select = vi.fn();
  render(<ResponsiveShell navigation={<button>Workspace channel</button>} routeKey="/dm/dm-1">
    <ChatHeader />
    <HermesRuntimePanel botName="Hermes" runtime={null} loading={false} onSelectThread={select} />
  </ResponsiveShell>);

  for (const width of [1440, 1280, 1100, 1024, 1023, 960, 900, 899, 390, 900, 1023, 1024, 1100]) {
    resize(width);
    const channel = screen.queryByRole("button", { name: "Workspace channel" });
    const navigation = screen.queryByRole("button", { name: "Open navigation" });
    const tasks = screen.queryByRole("complementary", { name: "Hermes tasks and activity" });
    const tasksToggle = screen.queryByRole("button", { name: "Open tasks and activity" });
    expect(Boolean(channel), `inline navigation at ${width}px`).toBe(width >= 1024);
    expect(Boolean(navigation), `navigation trigger at ${width}px`).toBe(width < 1024);
    expect(Boolean(tasks), `inline Tasks at ${width}px`).toBe(width >= 900);
    expect(Boolean(tasksToggle), `Tasks trigger at ${width}px`).toBe(width < 900);
  }

  resize(960);
  const navigation = screen.getByRole("button", { name: "Open navigation" });
  await user.click(navigation);
  expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(navigation).toHaveFocus();
  await user.click(within(screen.getByRole("complementary")).getByRole("button", { name: /General/ }));
  expect(select).toHaveBeenCalledWith(null);

  resize(899);
  await user.click(screen.getByRole("button", { name: "Open tasks and activity" }));
  expect(screen.getByRole("dialog", { name: "Tasks and activity" })).toBeInTheDocument();
  resize(900);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("complementary")).toBeInTheDocument();
  resize(899);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open navigation" }));
  resize(1024);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  resize(1023);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
