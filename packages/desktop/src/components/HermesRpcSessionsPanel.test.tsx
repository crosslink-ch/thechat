import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { HermesRpcSessionPublic } from "@thechat/shared";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

const sessions: HermesRpcSessionPublic[] = [
  {
    id: "stored-1",
    title: "Investigate flaky build",
    preview: "The failing shard points to a timeout",
    startedAt: 1_786_406_400,
    messageCount: 7,
    source: "cli",
    threadId: "thread-1",
    linked: true,
  },
  {
    id: "stored-2",
    title: "Release notes",
    preview: "Summarize the latest changes",
    startedAt: 1_786_492_800,
    messageCount: 2,
    source: "web",
    threadId: null,
    linked: false,
  },
];

describe("Hermes RPC sessions sidebar", () => {
  it("renders exact upstream metadata and selected state", () => {
    const onSelect = vi.fn();
    render(
      <HermesRuntimePanel
        botName="Hermes upstream"
        runtime={null}
        loading={false}
        rpcMode
        rpcSessions={sessions}
        selectedRpcSessionId="stored-1"
        onSelectRpcSession={onSelect}
      />,
    );

    expect(screen.getByTestId("hermes-rpc-sessions-panel")).toBeInTheDocument();
    expect(screen.getByText("Investigate flaky build")).toBeInTheDocument();
    expect(screen.getByText("The failing shard points to a timeout")).toBeInTheDocument();
    expect(screen.getByText("7 messages")).toBeInTheDocument();
    expect(screen.getByTestId("hermes-rpc-session-stored-1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByTestId("hermes-rpc-session-stored-2"));
    expect(onSelect).toHaveBeenCalledWith(sessions[1]);
  });

  it("shows loading, unavailable, empty, refresh, and new-session controls", () => {
    const { rerender } = render(
      <HermesRuntimePanel
        botName="Hermes upstream"
        runtime={null}
        loading={false}
        rpcMode
        rpcSessionsLoading
      />,
    );
    expect(screen.getByTestId("hermes-rpc-sessions-loading")).toBeInTheDocument();

    rerender(
      <HermesRuntimePanel
        botName="Hermes upstream"
        runtime={null}
        loading={false}
        rpcMode
        rpcSessionsError="gateway offline"
      />,
    );
    expect(screen.getByTestId("hermes-rpc-sessions-unavailable")).toHaveTextContent(
      "gateway offline",
    );

    const refresh = vi.fn();
    const create = vi.fn();
    rerender(
      <HermesRuntimePanel
        botName="Hermes upstream"
        runtime={null}
        loading={false}
        rpcMode
        onRefreshRpcSessions={refresh}
        onCreateThread={create}
      />,
    );
    expect(screen.getByTestId("hermes-rpc-sessions-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Hermes sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "New Hermes session" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
});
