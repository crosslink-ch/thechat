import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
} from "@thechat/shared";
import { HermesProgressInline } from "./HermesProgressInline";

describe("HermesProgressInline", () => {
  it("collapses tool start and completion events into one row", () => {
    render(
      <HermesProgressInline
        invocations={[invocation()]}
        events={[
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
