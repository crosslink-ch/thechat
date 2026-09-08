import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDmHeaderIdentity, useDmHeaderStore } from "../stores/chat-header";
import { ChatHeader } from "./ChatHeader";

const route = vi.hoisted(() => ({ id: "dm-1", userId: "user-1", token: "session-1" }));
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [{ fullPath: "/dm/$id", params: { id: route.id } }],
}));
vi.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: route.userId }, token: route.token }),
}));

function Identity({ title = "Ada", context, conversationId = "dm-1" }: { title?: string; context?: string; conversationId?: string }) {
  useDmHeaderIdentity({ conversationId, userId: "user-1", token: "session-1", title, context });
  return null;
}

beforeEach(() => {
  route.id = "dm-1";
  route.userId = "user-1";
  route.token = "session-1";
  useDmHeaderStore.setState({ identity: null });
});
afterEach(cleanup);

it("follows participant and task renames and clears identity when its route unmounts", () => {
  const view = render(<><ChatHeader /><Identity context="Review" /></>);
  expect(screen.getByText("Ada")).toBeInTheDocument();
  view.rerender(<><ChatHeader /><Identity title="Ada Lovelace" context="Review v2" /></>);
  expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  expect(screen.getByText("Review v2")).toBeInTheDocument();
  expect(screen.queryByText("Review")).not.toBeInTheDocument();
  view.rerender(<ChatHeader />);
  expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
  expect(useDmHeaderStore.getState().identity).toBeNull();
});

it("does not reuse the previous identity while another DM is loading", () => {
  const view = render(<><ChatHeader /><Identity /></>);
  route.id = "dm-2";
  view.rerender(<><ChatHeader /><Identity /></>);
  expect(screen.queryByText("Ada")).not.toBeInTheDocument();
  expect(screen.queryByText("Direct Message")).not.toBeInTheDocument();
  view.rerender(<><ChatHeader /><Identity conversationId="dm-2" title="Grace" /></>);
  expect(screen.getByText("Grace")).toBeInTheDocument();
});

it.each(["userId", "token"] as const)("does not show another session's identity after %s changes", (field) => {
  const view = render(<><ChatHeader /><Identity /></>);
  route[field] = "another-session";
  view.rerender(<><ChatHeader /><Identity /></>);
  expect(screen.queryByText("Ada")).not.toBeInTheDocument();
});

it("does not let an older route cleanup erase a newer owner", () => {
  const view = render(<><ChatHeader /><Identity key="old" title="Old" /><Identity key="new" title="New" /></>);
  expect(screen.getByText("New")).toBeInTheDocument();
  view.rerender(<><ChatHeader /><Identity key="new" title="New" /></>);
  expect(screen.getByText("New")).toBeInTheDocument();
  view.unmount();
  expect(useDmHeaderStore.getState().identity).toBeNull();
});
