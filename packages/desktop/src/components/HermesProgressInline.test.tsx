import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
} from "@thechat/shared";
import { HermesProgressInline } from "./HermesProgressInline";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";

describe("HermesProgressInline", () => {
  beforeEach(() => {
    useHermesApprovalsStore.getState().resetForTests();
  });

  it("collapses tool start and completion events into one row", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "patch-started",
                sequence: 1,
                type: "tool.started",
                status: "running",
                toolCallId: "call-patch",
                toolName: "patch",
                label: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                preview: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                payload: {
                  args: {
                    path: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                    mode: "replace",
                    new_string: "assert variance(outcomes, probabilities) == 2",
                  },
                },
              }),
              progressEvent({
                id: "patch-completed",
                sequence: 2,
                type: "tool.completed",
                status: "completed",
                toolCallId: "call-patch",
                toolName: "patch",
                label: null,
                preview: null,
                payload: {
                  args: {
                    path: "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
                    mode: "replace",
                    new_string: "assert variance(outcomes, probabilities) == 2",
                  },
                  duration: 0.2,
                },
              }),
              progressEvent({
                id: "terminal-started",
                sequence: 3,
                type: "tool.started",
                status: "running",
                toolCallId: "call-terminal",
                toolName: "terminal",
                label: "pwd && uv run pytest -q && uv run expected_value.py",
                preview: "pwd && uv run pytest -q && uv run expected_value.py",
                payload: {
                  args: {
                    command: "pwd && uv run pytest -q && uv run expected_value.py",
                    timeout: 300,
                  },
                },
              }),
              progressEvent({
                id: "terminal-completed",
                sequence: 4,
                type: "tool.completed",
                status: "completed",
                toolCallId: "call-terminal",
                toolName: "terminal",
                label: null,
                preview: null,
                payload: {
                  args: {
                    command: "pwd && uv run pytest -q && uv run expected_value.py",
                    timeout: 300,
                  },
                  duration: 4.5,
                },
              }),
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getAllByText(
        "/home/bruno/projects/python-probability-study/tests/test_expected_value.py",
      ),
    ).toHaveLength(1);
    expect(
      screen.getAllByText("pwd && uv run pytest -q && uv run expected_value.py"),
    ).toHaveLength(1);
    expect(screen.queryByText(/^patch: mode=replace/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^terminal: command=pwd/)).not.toBeInTheDocument();
    expect(screen.getByText("0.2s")).toBeInTheDocument();
    expect(screen.getByText("4.5s")).toBeInTheDocument();
  });

  it("renders notices and reasoning separately from tool activity", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "notice",
                sequence: 1,
                type: "notice.lifecycle",
                status: "info",
                toolCallId: null,
                toolName: null,
                label: "Codex gpt-5.5 caps context at 272K",
              }),
              progressEvent({
                id: "legacy-status",
                sequence: 2,
                type: "status.warn",
                status: "warning",
                toolCallId: null,
                toolName: null,
                label: "Compression provider is unavailable",
              }),
              progressEvent({
                id: "reasoning",
                sequence: 3,
                type: "reasoning.available",
                status: "running",
                toolCallId: null,
                toolName: null,
                preview: "Drafting a response before using tools\nmore detail",
                payload: { text: "Drafting a response before using tools" },
              }),
              progressEvent({
                id: "tool",
                sequence: 4,
                type: "tool.started",
                status: "running",
                toolCallId: "call-read",
                toolName: "read_file",
                label: "Read task context",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("info")).toBeInTheDocument();
    expect(screen.getByText("warn")).toBeInTheDocument();
    expect(screen.getByText("Codex gpt-5.5 caps context at 272K")).toBeInTheDocument();
    expect(screen.getByText("Compression provider is unavailable")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Drafting a response before using tools")).toBeInTheDocument();
    expect(screen.getByText("Read task context")).toBeInTheDocument();
  });

  it("does not treat reasoning events with an internal tool name as tools", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "reasoning",
                type: "reasoning.available",
                toolCallId: null,
                toolName: "_thinking",
                preview: "Considering the request",
                payload: { text: "Considering the request" },
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Considering the request")).toBeInTheDocument();
    expect(screen.queryByText(/^_thinking/)).not.toBeInTheDocument();
  });

  it("renders error notices without treating them as tool activity", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "error-notice",
                type: "notice.error",
                status: "failed",
                toolCallId: null,
                toolName: null,
                label: "Compression provider failed",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("Compression provider failed")).toBeInTheDocument();
  });

  it("shows emitted tool names next to bare progress labels", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "skill-view",
                type: "tool.started",
                status: "running",
                toolCallId: "call-skill",
                toolName: "skill_view",
                label: "html-math-study-notes",
                preview: "html-math-study-notes",
                payload: {
                  args: { name: "html-math-study-notes" },
                },
              }),
              progressEvent({
                id: "custom-tool",
                type: "tool.started",
                status: "running",
                toolCallId: "call-custom",
                toolName: "custom_tool",
                label: "external context",
                preview: "external context",
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("skill_view")).toBeInTheDocument();
    expect(screen.getByText("html-math-study-notes")).toBeInTheDocument();
    expect(screen.getByText("custom_tool")).toBeInTheDocument();
    expect(screen.getByText("external context")).toBeInTheDocument();
  });

  it("renders approval actions as buttons mapped to Hermes slash commands", () => {
    const onApprovalCommand = vi.fn();
    const approval = progressEvent({
      id: "approval-1",
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      label: "Command approval required",
      preview: "rm -rf /important",
      payload: {
        command: "rm -rf /important",
        description: "recursive delete",
        choices: ["once", "session", "always", "deny"],
      },
    });
    const { rerender } = render(
      <HermesProgressInline
        invocations={[{ invocation: invocation(), events: [approval] }]}
        onApprovalCommand={onApprovalCommand}
      />,
    );

    expect(screen.getByText("Koda wants to run a command")).toBeInTheDocument();
    expect(screen.getByText("recursive delete")).toBeInTheDocument();
    expect(screen.getByText("rm -rf /important")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprovalCommand).toHaveBeenLastCalledWith("/approve");

    rerender(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [{ ...approval, id: "approval-2" }],
          },
        ]}
        onApprovalCommand={onApprovalCommand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve for session" }));
    expect(onApprovalCommand).toHaveBeenLastCalledWith("/approve session");

    rerender(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [{ ...approval, id: "approval-3" }],
          },
        ]}
        onApprovalCommand={onApprovalCommand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Always approve" }));
    expect(onApprovalCommand).toHaveBeenLastCalledWith("/approve always");

    rerender(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [{ ...approval, id: "approval-4" }],
          },
        ]}
        onApprovalCommand={onApprovalCommand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApprovalCommand).toHaveBeenLastCalledWith("/deny");
  });

  it("collapses the approval card into a resolved row after a decision", () => {
    const onApprovalCommand = vi.fn();
    const approval = progressEvent({
      id: "approval-1",
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      preview: "rm -rf /important",
      payload: { command: "rm -rf /important" },
    });

    render(
      <HermesProgressInline
        invocations={[{ invocation: invocation(), events: [approval] }]}
        onApprovalCommand={onApprovalCommand}
      />,
    );

    expect(screen.getByText(/is waiting for your approval/)).toBeInTheDocument();
    expect(screen.getByText("action needed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(screen.queryByTestId("hermes-approval-request")).not.toBeInTheDocument();
    expect(screen.getByTestId("hermes-approval-resolved")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByText("action needed")).not.toBeInTheDocument();
    expect(screen.getByText(/is working/)).toBeInTheDocument();
  });

  it("keeps a sent decision after the component remounts", () => {
    const approval = progressEvent({
      id: "approval-1",
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      payload: { command: "rm -rf /important" },
    });
    const view = render(
      <HermesProgressInline
        invocations={[{ invocation: invocation(), events: [approval] }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    view.unmount();

    render(
      <HermesProgressInline
        invocations={[{ invocation: invocation(), events: [approval] }]}
      />,
    );

    expect(screen.queryByTestId("hermes-approval-request")).not.toBeInTheDocument();
    expect(screen.getByText("Denied")).toBeInTheDocument();
  });

  it("resolves approval requests from gateway approval.resolved events", () => {
    const approval = progressEvent({
      id: "approval-1",
      sequence: 1,
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      payload: { command: "sudo systemctl restart api", sessionKey: "dm:1" },
    });
    const resolution = progressEvent({
      id: "resolution-1",
      sequence: 2,
      type: "approval.resolved",
      status: "completed",
      toolCallId: null,
      toolName: null,
      payload: { choice: "session", sessionKey: "dm:1" },
    });

    render(
      <HermesProgressInline
        invocations={[
          { invocation: invocation(), events: [approval, resolution] },
        ]}
      />,
    );

    expect(screen.queryByTestId("hermes-approval-request")).not.toBeInTheDocument();
    expect(screen.getByText("Approved for session")).toBeInTheDocument();
    expect(screen.getByText("sudo systemctl restart api")).toBeInTheDocument();
  });

  it("enables pending approval actions in FIFO order", () => {
    const onApprovalCommand = vi.fn();
    const firstApproval = progressEvent({
      id: "approval-1",
      sequence: 1,
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { command: "rm -rf /first" },
    });
    const secondApproval = progressEvent({
      id: "approval-2",
      sequence: 2,
      type: "approval.request",
      status: "waiting",
      toolCallId: null,
      toolName: null,
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: { command: "rm -rf /second" },
    });

    render(
      <HermesProgressInline
        invocations={[
          { invocation: invocation(), events: [firstApproval, secondApproval] },
        ]}
        onApprovalCommand={onApprovalCommand}
      />,
    );

    // Only the oldest pending approval is actionable; the later one waits.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(
      screen.getByText("Waiting for the earlier approval to be resolved first."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprovalCommand).toHaveBeenCalledWith("/approve");
    // First request collapses into a resolved row; the second becomes actionable.
    expect(screen.getByTestId("hermes-approval-resolved")).toBeInTheDocument();
    expect(screen.getByText("rm -rf /first")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(
      screen.queryByText("Waiting for the earlier approval to be resolved first."),
    ).not.toBeInTheDocument();
  });

  it("renders activity rows in the order events happened", () => {
    // Terminal -> approval (resolved) -> thinking -> terminal: rows must keep
    // this order instead of grouping by type.
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "tool-1-started",
                sequence: 1,
                type: "tool.started",
                status: "running",
                toolCallId: "call-1",
                toolName: "terminal",
                label: "du -sh /var/cache",
              }),
              progressEvent({
                id: "tool-1-completed",
                sequence: 2,
                type: "tool.completed",
                status: "completed",
                toolCallId: "call-1",
                toolName: "terminal",
                payload: { duration: 1.2 },
              }),
              progressEvent({
                id: "approval-1",
                sequence: 3,
                type: "approval.request",
                status: "waiting",
                toolCallId: null,
                toolName: null,
                payload: { command: "rm -rf /var/cache/old" },
              }),
              progressEvent({
                id: "resolution-1",
                sequence: 4,
                type: "approval.resolved",
                status: "completed",
                toolCallId: null,
                toolName: null,
                payload: { choice: "once" },
              }),
              progressEvent({
                id: "reasoning-1",
                sequence: 5,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "Cleanup finished, verifying disk usage" },
              }),
              progressEvent({
                id: "tool-2-started",
                sequence: 6,
                type: "tool.started",
                status: "running",
                toolCallId: "call-2",
                toolName: "terminal",
                label: "df -h /var/cache",
              }),
            ],
          },
        ]}
      />,
    );

    const kinds = screen
      .getAllByTestId("hermes-activity-row")
      .map((row) => row.dataset.kind);
    expect(kinds).toEqual(["tool", "approval-resolved", "reasoning", "tool"]);
  });

  it("collapses consecutive reasoning events but keeps separated blocks apart", () => {
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "reasoning-1",
                sequence: 1,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "First thought" },
              }),
              progressEvent({
                id: "reasoning-2",
                sequence: 2,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "Refined thought" },
              }),
              progressEvent({
                id: "tool-1",
                sequence: 3,
                type: "tool.started",
                status: "running",
                toolCallId: "call-1",
                toolName: "terminal",
                label: "ls",
              }),
              progressEvent({
                id: "reasoning-3",
                sequence: 4,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: "Second block" },
              }),
            ],
          },
        ]}
      />,
    );

    const kinds = screen
      .getAllByTestId("hermes-activity-row")
      .map((row) => row.dataset.kind);
    expect(kinds).toEqual(["reasoning", "tool", "reasoning"]);
    // The first block shows its latest text, not the first delta.
    expect(screen.getByText("Refined thought")).toBeInTheDocument();
    expect(screen.queryByText("First thought")).not.toBeInTheDocument();
    expect(screen.getByText("Second block")).toBeInTheDocument();
  });

  it("expands tool and thinking rows to show the full text", () => {
    const longCommand =
      "find /var/cache/builds -type d -mtime +30 -print0 | xargs -0 du -sh | sort -rh | head -50";
    const reasoningText = "Line one of thinking\nLine two with more detail";
    render(
      <HermesProgressInline
        invocations={[
          {
            invocation: invocation(),
            events: [
              progressEvent({
                id: "tool-1",
                sequence: 1,
                type: "tool.started",
                status: "running",
                toolCallId: "call-1",
                toolName: "terminal",
                label: longCommand,
              }),
              progressEvent({
                id: "reasoning-1",
                sequence: 2,
                type: "reasoning.available",
                toolCallId: null,
                toolName: null,
                payload: { text: reasoningText },
              }),
            ],
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("hermes-activity-detail")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: new RegExp("terminal") }));
    expect(screen.getByTestId("hermes-activity-detail")).toHaveTextContent(
      "head -50",
    );

    fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
    const details = screen.getAllByTestId("hermes-activity-detail");
    expect(details).toHaveLength(2);
    expect(details[1]).toHaveTextContent("Line two with more detail");

    fireEvent.click(screen.getByRole("button", { name: new RegExp("terminal") }));
    expect(screen.getAllByTestId("hermes-activity-detail")).toHaveLength(1);
  });

  it("keeps pending approvals visible beyond the row window", () => {
    const events = [
      progressEvent({
        id: "approval-early",
        sequence: 1,
        type: "approval.request",
        status: "waiting",
        toolCallId: null,
        toolName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { command: "rm -rf /important" },
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        progressEvent({
          id: `tool-${index}`,
          sequence: index + 2,
          type: "tool.started",
          status: "running",
          toolCallId: `call-${index}`,
          toolName: "terminal",
          label: `step ${index}`,
        }),
      ),
    ];

    render(
      <HermesProgressInline
        invocations={[{ invocation: invocation(), events }]}
      />,
    );

    expect(screen.getByTestId("hermes-approval-request")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByText(/earlier update/)).toBeInTheDocument();
  });
});

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
    threadId: null,
    triggerMessageId: "message-1",
    responseMessageId: null,
    adapterKind: "hermes",
    status: "running",
    externalRunId: null,
    requestJson: null,
    responseJson: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function progressEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "event-1",
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    sequence: 1,
    type: "tool.started",
    status: null,
    toolCallId: "tool-call-1",
    toolName: "terminal",
    label: null,
    preview: null,
    payload: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}
