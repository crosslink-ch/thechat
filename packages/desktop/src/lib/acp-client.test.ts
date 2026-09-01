import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpConnectResult,
  AcpEvent,
  AcpPromptResult,
} from "@thechat/shared";

const { channels, MockChannel, coreInvoke } = vi.hoisted(() => {
  const channelInstances: Array<{
    onmessage: ((event: AcpEvent) => void) | null;
  }> = [];
  class HoistedMockChannel {
    onmessage: ((event: AcpEvent) => void) | null = null;
    constructor() {
      channelInstances.push(this);
    }
  }
  return {
    channels: channelInstances,
    MockChannel: HoistedMockChannel,
    coreInvoke: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: coreInvoke,
  Channel: MockChannel,
}));

import { invoke } from "@tauri-apps/api/core";
import {
  ACP_COMMANDS,
  beginAcpTurn,
  cancelAcp,
  completeAcpTurn,
  connectAcp,
  disconnectAcp,
  promptAcp,
  respondToAcpPermission,
} from "./acp-client";

const invokeMock = vi.mocked(invoke);
const connectResult: AcpConnectResult = {
  conversationId: "conversation-1",
  profileId: "profile-1",
  generation: 3,
  sessionId: "session-1",
  capabilities: { loadSession: true, prompt: { image: false } },
};
const promptResult: AcpPromptResult = {
  conversationId: "conversation-1",
  generation: 3,
  turnId: "turn-1",
  stopReason: "end_turn",
  sessionId: "session-1",
};

beforeEach(() => {
  channels.length = 0;
  invokeMock.mockReset();
});

describe("ACP Tauri bridge", () => {
  it("uses the provisional commands and camelCase payloads in one module", async () => {
    invokeMock
      .mockResolvedValueOnce(connectResult)
      .mockResolvedValueOnce(promptResult)
      .mockResolvedValue(undefined);

    await connectAcp(
      {
        conversationId: "conversation-1",
        profileId: "profile-1",
        cwd: "/workspace/project",
        generation: 3,
      },
      vi.fn(),
    );
    await promptAcp(
      {
        conversationId: "conversation-1",
        turnToken: "turn-token-1",
        contentBlocks: [
          { type: "text", text: "Implement it" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        permissionMode: "allow-edits",
        generation: 3,
      },
      vi.fn(),
    );
    await cancelAcp({ conversationId: "conversation-1", generation: 3 });
    await respondToAcpPermission({
      conversationId: "conversation-1",
      generation: 3,
      requestId: "permission-1",
      optionId: "opaque-allow-once",
    });
    await disconnectAcp({ conversationId: "conversation-1", generation: 3 });

    expect(ACP_COMMANDS).toEqual({
      beginTurn: "acp_begin_turn",
      completeTurn: "acp_complete_turn",
      connect: "acp_connect",
      prompt: "acp_prompt",
      cancel: "acp_cancel",
      respondPermission: "acp_respond_permission",
      disconnect: "acp_disconnect",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "acp_connect", {
      conversationId: "conversation-1",
      profileId: "profile-1",
      cwd: "/workspace/project",
      generation: 3,
      onEvent: expect.any(MockChannel),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "acp_prompt", {
      conversationId: "conversation-1",
      turnToken: "turn-token-1",
      contentBlocks: [
        { type: "text", text: "Implement it" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      permissionMode: "allow-edits",
      generation: 3,
      onEvent: expect.any(MockChannel),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "acp_cancel", {
      conversationId: "conversation-1",
      generation: 3,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "acp_respond_permission", {
      conversationId: "conversation-1",
      generation: 3,
      requestId: "permission-1",
      optionId: "opaque-allow-once",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "acp_disconnect", {
      conversationId: "conversation-1",
      generation: 3,
    });
  });

  it("uses backend-owned atomic ACP turn ledger commands", async () => {
    const userMessage = {
      id: "user-message-1",
      conversation_id: "conversation-1",
      role: "user",
      content: "hello",
      reasoning_content: null,
      created_at: "2026-09-01T00:00:00Z",
    };
    const assistantMessage = {
      ...userMessage,
      id: "assistant-message-1",
      role: "assistant",
      content: "answer",
    };
    invokeMock
      .mockResolvedValueOnce({ message: userMessage, turnToken: "turn-token-1" })
      .mockResolvedValueOnce(assistantMessage);

    await beginAcpTurn({
      conversationId: "conversation-1",
      generation: 3,
      content: "hello",
      reasoningContent: null,
    });
    await completeAcpTurn({
      conversationId: "conversation-1",
      generation: 3,
      turnToken: "turn-token-1",
      content: "answer",
      reasoningContent: "thought",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "acp_begin_turn", {
      conversationId: "conversation-1",
      generation: 3,
      content: "hello",
      reasoningContent: null,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "acp_complete_turn", {
      conversationId: "conversation-1",
      generation: 3,
      turnToken: "turn-token-1",
      content: "answer",
      reasoningContent: "thought",
    });
  });

  it("suppresses session/load transcript replay from the connect channel", async () => {
    invokeMock.mockResolvedValue(connectResult);
    const onLifecycleEvent = vi.fn();
    const promise = connectAcp(
      {
        conversationId: "conversation-1",
        profileId: "profile-1",
        cwd: "/workspace/project",
        generation: 3,
      },
      onLifecycleEvent,
    );

    const channel = channels[0];
    channel.onmessage?.({
      type: "text_delta",
      conversationId: "conversation-1",
      generation: 3,
      sequence: 42,
      turnId: "replayed-turn",
      text: "old assistant transcript",
    });
    channel.onmessage?.({
      type: "reasoning_delta",
      conversationId: "conversation-1",
      generation: 3,
      sequence: 43,
      turnId: "replayed-turn",
      text: "old thought",
    });
    channel.onmessage?.({
      type: "connected",
      conversationId: "conversation-1",
      generation: 3,
      sequence: 44,
      sessionId: "session-1",
      capabilities: connectResult.capabilities,
      resumed: true,
    });
    await promise;

    expect(onLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(onLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connected", resumed: true }),
    );
  });

  it("forwards only active prompt-channel events for the requested conversation generation", async () => {
    invokeMock.mockResolvedValue(promptResult);
    const onEvent = vi.fn();
    const promise = promptAcp(
      {
        conversationId: "conversation-1",
        turnToken: "turn-token-1",
        contentBlocks: [{ type: "text", text: "hello" }],
        permissionMode: "request",
        generation: 3,
      },
      onEvent,
    );
    const channel = channels[0];

    channel.onmessage?.({
      type: "text_delta",
      conversationId: "conversation-1",
      generation: 2,
      sequence: 1,
      turnId: "stale",
      text: "stale",
    });
    channel.onmessage?.({
      type: "text_delta",
      conversationId: "other-conversation",
      generation: 3,
      sequence: 2,
      turnId: "other",
      text: "other",
    });
    const activeEvent: AcpEvent = {
      type: "text_delta",
      conversationId: "conversation-1",
      generation: 3,
      sequence: 3,
      turnId: "turn-1",
      text: "current",
    };
    channel.onmessage?.(activeEvent);
    await promise;

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(activeEvent);
  });

  it("preserves the exact permission option ID including an explicit cancellation", async () => {
    invokeMock.mockResolvedValue(undefined);

    await respondToAcpPermission({
      conversationId: "conversation-1",
      generation: 3,
      requestId: "permission-1",
      optionId: null,
    });

    expect(invokeMock).toHaveBeenCalledWith("acp_respond_permission", {
      conversationId: "conversation-1",
      generation: 3,
      requestId: "permission-1",
      optionId: null,
    });
  });
});
