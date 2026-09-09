import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatHeader } from "./ChatHeader";
import { ResponsiveShell } from "./ResponsiveShell";

vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [{ fullPath: "/channel/$id", params: { id: "general" } }],
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("provides the navigation entry point inside the mobile shell", () => {
  vi.stubGlobal("matchMedia", () => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  render(<ResponsiveShell navigation={<p>Channels</p>} routeKey="general"><ChatHeader /></ResponsiveShell>);
  expect(screen.getByRole("button", {name:"Open navigation"})).toBeInTheDocument();
});

it("names the back action for screen readers and touch users", () => {
  render(<ChatHeader />);
  expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
});
