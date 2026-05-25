import { describe, expect, it, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BotInvocationPublic } from "@thechat/shared";
import { ChannelChatView } from "./ChannelChatView";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("ChannelChatView Hermes progress", () => {
  it("hides the generic typing indicator while Hermes progress is active", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[invocation({ status: "running" })]}
        progressEvents={[]}
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Koda is working")).toBeInTheDocument();
    expect(screen.queryByText("Koda is typing...")).toBeNull();
  });

  it("shows the generic typing indicator when there is no active progress", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[]}
        progressEvents={[]}
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Koda is typing...")).toBeInTheDocument();
  });

  it("can suppress generic typing even when visible progress is scoped out", () => {
    render(
      <ChannelChatView
        messages={[]}
        loading={false}
        typingUsers={new Map([["bot-user-1", "Koda"]])}
        progressInvocations={[]}
        progressEvents={[]}
        typingSuppressedUserIds={["bot-user-1"]}
        onSend={() => {}}
      />,
    );

    expect(screen.queryByText("Koda is typing...")).toBeNull();
  });
});

function invocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "invocation-1",
    botSessionId: "session-1",
    botId: "bot-1",
    botUserId: "bot-user-1",
    botName: "Koda",
    botKind: "hermes",
    conversationId: "conversation-1",
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
