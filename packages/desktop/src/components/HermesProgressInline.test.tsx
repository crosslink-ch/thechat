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
    hermesSession: null,
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
