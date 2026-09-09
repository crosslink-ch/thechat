import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader";
import { ResponsiveShell } from "./ResponsiveShell";

const routeState = vi.hoisted(() => ({ path: "/channel/$id" }));
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [{ fullPath: routeState.path, params: { id: "general" } }],
}));
afterEach(() => {
  cleanup();
  routeState.path = "/channel/$id";
  vi.unstubAllGlobals();
});

it("provides the navigation entry point inside the mobile shell", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  render(
    <ResponsiveShell navigation={<p>Channels</p>} routeKey="general">
      <ChatHeader />
    </ResponsiveShell>,
  );
  expect(
    screen.getByRole("button", { name: "Open navigation" }),
  ).toBeInTheDocument();
});

it("names the back action for screen readers and touch users", () => {
  render(<ChatHeader />);
  expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
});

vi.mock("../CommandPalette", () => ({ togglePalette: vi.fn() }));
import { togglePalette } from "../CommandPalette";
it("has a visible touch search trigger", () => {
  render(<ChatHeader />);
  const search = screen.getByRole("button", { name: "Search" });
  expect(search).toBeVisible();
  fireEvent.click(search);
  expect(togglePalette).toHaveBeenCalledOnce();
});

it.each(["/", "/activity"])(
  "keeps mobile Search reachable on %s without a selected conversation",
  (path) => {
    routeState.path = path;
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(
      <ResponsiveShell navigation={<p>Navigation</p>} routeKey={path}>
        <ChatHeader />
      </ResponsiveShell>,
    );
    expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
  },
);
