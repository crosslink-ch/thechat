import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpConnectResult,
  AcpEvent,
  AcpPromptResult,
  Conversation,
  DbMessage,
} from "@thechat/shared";
import { useStreamingStore } from "../stores/streaming";

const bridge = vi.hoisted(() => ({
  abortAcpTurn: vi.fn(),
  beginAcpTurn: vi.fn(),
  completeAcpTurn: vi.fn(),
  connectAcp: vi.fn(),
  promptAcp: vi.fn(),
  cancelAcp: vi.fn(),
  respondToAcpPermission: vi.fn(),
  disconnectAcp: vi.fn(),
}));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
const imageMocks = vi.hoisted(() => ({ saveImage: vi.fn() }));

vi.mock("../lib/acp-client", () => bridge);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../lib/images", () => ({ saveImage: imageMocks.saveImage }));

import {
  activeAcpSessionCountForTests,
  resetAcpChatForTests,
  useAcpChat,
} from "./useAcpChat";
import { useAcpStore } from "../stores/acp";

const profileId = "profile-1";
const projectDir = "/workspace/project";
const conversation: Conversation = {
  id: "conversation-1",
  title: "hello",
  project_dir: projectDir,
  agent_profile_id: profileId,
  acp_session_id: null,
  acp_profile_fingerprint: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
};
const connectResult: AcpConnectResult = {
  conversationId: conversation.id,
  profileId,
  generation: 1,
  sessionId: "session-1",
  capabilities: { loadSession: true, prompt: { image: false } },
  resumed: false,
};
const promptResult: AcpPromptResult = {
  conversationId: conversation.id,
  generation: 1,
  turnId: "turn-1",
  stopReason: "end_turn",
  sessionId: "session-1",
};

let messageCounter = 0;
let savedMessages: Array<{ command: string; args: Record<string, unknown> }> = [];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type AcpEventInput = DistributiveOmit<
  AcpEvent,
  "conversationId" | "generation"
>;

function installDatabaseMock() {
  invokeMock.mockImplementation(
    async (command: string) => {
      if (command === "get_messages") return [];
      if (command === "create_conversation") return conversation;
      throw new Error(`Unexpected IPC command: ${command}`);
    },
  );
}

function activeEvent(
  value: AcpEventInput,
): AcpEvent {
  return {
    conversationId: conversation.id,
    generation: 1,
    ...value,
  } as AcpEvent;
}

function emitSuccessfulTurn(onEvent: (event: AcpEvent) => void) {
  onEvent(activeEvent({ type: "turn_started", sequence: 101, turnId: "turn-1" }));
  onEvent(
    activeEvent({
      type: "reasoning_delta",
      sequence: 102,
      turnId: "turn-1",
      text: "Thinking",
    }),
  );
  onEvent(
    activeEvent({
      type: "text_delta",
      sequence: 103,
      turnId: "turn-1",
      text: "ACP response",
    }),
  );
  onEvent(
    activeEvent({
      type: "turn_finished",
      sequence: 104,
      turnId: "turn-1",
      result: { stopReason: "end_turn", sessionId: "session-1" },
    }),
  );
}

beforeEach(() => {
  resetAcpChatForTests();
  useAcpStore.getState().resetForTests();
  useStreamingStore.setState({ streamingConvIds: new Set() });
  bridge.abortAcpTurn.mockReset();
  bridge.beginAcpTurn.mockReset();
  bridge.completeAcpTurn.mockReset();
  bridge.connectAcp.mockReset();
  bridge.promptAcp.mockReset();
  bridge.cancelAcp.mockReset();
  bridge.respondToAcpPermission.mockReset();
  bridge.disconnectAcp.mockReset();
  imageMocks.saveImage.mockReset();
  imageMocks.saveImage.mockResolvedValue("/saved/image.png");
  invokeMock.mockReset();
  messageCounter = 0;
  savedMessages = [];
  installDatabaseMock();
  bridge.abortAcpTurn.mockResolvedValue(undefined);
  bridge.beginAcpTurn.mockImplementation(async (payload: Record<string, unknown>) => {
    savedMessages.push({ command: "acp_begin_turn", args: payload });
    messageCounter += 1;
    return {
      turnToken: `turn-token-${messageCounter}`,
      message: {
        id: `message-${messageCounter}`,
        conversation_id: String(payload.conversationId),
        role: "user",
        content: String(payload.content),
        reasoning_content:
          typeof payload.reasoningContent === "string"
            ? payload.reasoningContent
            : null,
        created_at: `2026-08-31T10:00:0${messageCounter}.000Z`,
      } satisfies DbMessage,
    };
  });
  bridge.completeAcpTurn.mockImplementation(async (payload: Record<string, unknown>) => {
    savedMessages.push({ command: "acp_complete_turn", args: payload });
    messageCounter += 1;
    return {
      id: `message-${messageCounter}`,
      conversation_id: String(payload.conversationId),
      role: "assistant",
      content: String(payload.content),
      reasoning_content:
        typeof payload.reasoningContent === "string"
          ? payload.reasoningContent
          : null,
      created_at: `2026-08-31T10:00:0${messageCounter}.000Z`,
    } satisfies DbMessage;
  });
  bridge.connectAcp.mockResolvedValue(connectResult);
  bridge.cancelAcp.mockResolvedValue(undefined);
  bridge.respondToAcpPermission.mockResolvedValue(undefined);
  bridge.disconnectAcp.mockResolvedValue(undefined);
  bridge.promptAcp.mockImplementation(
    async (_input: unknown, onEvent: (event: AcpEvent) => void) => {
      emitSuccessfulTurn(onEvent);
      return promptResult;
    },
  );
});

describe("useAcpChat", () => {
  it("creates an ACP conversation, suppresses connect replay, streams, and persists the turn", async () => {
    bridge.connectAcp.mockImplementation(
      async (_input: unknown, onLifecycleEvent: (event: AcpEvent) => void) => {
        // A raw mock bypasses bridge filtering; the hook must still never fold
        // session/load replay into the current assistant message.
        onLifecycleEvent(
          activeEvent({
            type: "text_delta",
            sequence: 90,
            turnId: "replayed-turn",
            text: "old replayed transcript",
          }),
        );
        return connectResult;
      },
    );
    const { result } = renderHook(() =>
      useAcpChat({
        profileId,
        projectDir,
        permissionMode: "allow-edits",
      }),
    );

    let accepted = false;
    await act(async () => {
      accepted = await result.current.sendMessage("hello");
    });

    expect(accepted).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("create_conversation", {
      title: "hello",
      projectDir,
      agentProfileId: profileId,
    });
    expect(bridge.connectAcp).toHaveBeenCalledWith(
      { conversationId: conversation.id, profileId, cwd: projectDir, generation: 1 },
      expect.any(Function),
    );
    expect(bridge.promptAcp).toHaveBeenCalledWith(
      {
        conversationId: conversation.id,
        turnToken: "turn-token-1",
        contentBlocks: [{ type: "text", text: "hello" }],
        permissionMode: "allow-edits",
        generation: 1,
      },
      expect.any(Function),
    );
    expect(result.current.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result.current.messages[1].parts).toEqual([
      { type: "reasoning", text: "Thinking" },
      { type: "text", text: "ACP response" },
    ]);
    expect(JSON.stringify(result.current.messages)).not.toContain(
      "old replayed transcript",
    );
    expect(savedMessages).toHaveLength(2);
    expect(savedMessages[1].args).toMatchObject({
      conversationId: conversation.id,
      turnToken: "turn-token-1",
      content: "ACP response",
      reasoningContent: "Thinking",
    });
    expect(useStreamingStore.getState().streamingConvIds).not.toContain(
      conversation.id,
    );
  });

  it("disconnects and leaves the backend dirty ledger closed when completion persistence fails", async () => {
    bridge.completeAcpTurn.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    await act(async () => {
      expect(await result.current.sendMessage("first")).toBe(false);
    });
    expect(bridge.beginAcpTurn).toHaveBeenCalledOnce();
    expect(bridge.completeAcpTurn).toHaveBeenCalledOnce();
    expect(bridge.disconnectAcp).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
    });
    expect(result.current.error?.message).toContain("disk full");

    bridge.beginAcpTurn.mockRejectedValueOnce(
      new Error("This conversation has an unfinished ACP turn"),
    );
    await act(async () => {
      expect(await result.current.sendMessage("second")).toBe(false);
    });
    expect(bridge.promptAcp).toHaveBeenCalledOnce();
  });

  it("rejects oversized prompt text before creating or persisting a conversation", async () => {
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    let accepted = true;
    await act(async () => {
      accepted = await result.current.sendMessage("x".repeat(256 * 1024 + 1));
    });

    expect(accepted).toBe(false);
    expect(result.current.error?.message).toMatch(/resource limit/i);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "create_conversation",
      expect.anything(),
    );
    expect(bridge.beginAcpTurn).not.toHaveBeenCalled();
    expect(bridge.connectAcp).not.toHaveBeenCalled();
  });

  it("sends advertised image input as ACP blocks and persists only file references", async () => {
    bridge.connectAcp.mockResolvedValue({
      ...connectResult,
      capabilities: {
        ...connectResult.capabilities,
        prompt: { image: true, audio: false, embeddedContext: false },
      },
    });
    const image = {
      id: "image-1",
      mimeType: "image/png",
      base64: "aW1hZ2U=",
    };
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    await act(async () => {
      expect(await result.current.sendMessage("look", [image])).toBe(true);
    });

    expect(imageMocks.saveImage).toHaveBeenCalledWith(conversation.id, image);
    expect(bridge.promptAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        contentBlocks: [
          { type: "text", text: "look" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      }),
      expect.any(Function),
    );
    expect(JSON.parse(String(savedMessages[0].args.content))).toEqual([
      { type: "text", text: "look" },
      { type: "image", path: "/saved/image.png", mimeType: "image/png" },
    ]);
    expect(String(savedMessages[0].args.content)).not.toContain("aW1hZ2U=");
  });

  it("rejects a second prompt while the conversation has an active turn", async () => {
    let finishPrompt!: () => void;
    bridge.promptAcp.mockImplementation(
      (_input: unknown, onEvent: (event: AcpEvent) => void) =>
        new Promise<AcpPromptResult>((resolve) => {
          onEvent(activeEvent({ type: "turn_started", sequence: 1, turnId: "turn-1" }));
          finishPrompt = () => {
            onEvent(
              activeEvent({
                type: "turn_finished",
                sequence: 2,
                turnId: "turn-1",
                result: { stopReason: "end_turn" },
              }),
            );
            resolve(promptResult);
          };
        }),
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    let firstPrompt!: Promise<boolean>;
    act(() => {
      firstPrompt = result.current.sendMessage("first");
    });
    await waitFor(() => expect(bridge.promptAcp).toHaveBeenCalledOnce());

    let secondAccepted = true;
    await act(async () => {
      secondAccepted = await result.current.sendMessage("second");
    });
    expect(secondAccepted).toBe(false);
    expect(result.current.error?.message).toMatch(/already active/i);
    expect(bridge.promptAcp).toHaveBeenCalledOnce();

    await act(async () => {
      finishPrompt();
      await firstPrompt;
    });
  });

  it("reconciles a background turn into a remounted conversation", async () => {
    let finishPrompt!: () => void;
    bridge.promptAcp.mockImplementation(
      (_input: unknown, onEvent: (event: AcpEvent) => void) =>
        new Promise<AcpPromptResult>((resolve) => {
          onEvent(activeEvent({ type: "turn_started", sequence: 1, turnId: "turn-1" }));
          finishPrompt = () => {
            emitSuccessfulTurn(onEvent);
            resolve(promptResult);
          };
        }),
    );
    const first = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = first.result.current.sendMessage("background");
    });
    await waitFor(() => expect(bridge.promptAcp).toHaveBeenCalledOnce());
    first.unmount();

    const second = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    await act(async () => {
      await second.result.current.loadConversation(conversation);
    });
    expect(second.result.current.isBusy).toBe(true);

    await act(async () => {
      finishPrompt();
      await pending;
    });
    await waitFor(() =>
      expect(second.result.current.messages.some((message) => message.role === "assistant"))
        .toBe(true),
    );
    expect(second.result.current.isBusy).toBe(false);
    second.unmount();
  });

  it("retires a session after its background turn completes with no mounted owner", async () => {
    let finishPrompt!: () => void;
    bridge.promptAcp.mockImplementation(
      (_input: unknown, onEvent: (event: AcpEvent) => void) =>
        new Promise<AcpPromptResult>((resolve) => {
          finishPrompt = () => {
            emitSuccessfulTurn(onEvent);
            resolve(promptResult);
          };
        }),
    );
    const hook = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = hook.result.current.sendMessage("background");
    });
    await waitFor(() => expect(bridge.promptAcp).toHaveBeenCalledOnce());
    hook.unmount();

    finishPrompt();
    await pending;
    await waitFor(() =>
      expect(bridge.disconnectAcp).toHaveBeenCalledWith({
        conversationId: conversation.id,
        generation: 1,
      }),
    );
  });

  it("traverses more than eight completed chats without retaining adapter sessions", async () => {
    for (let index = 0; index < 9; index += 1) {
      const nextConversation = {
        ...conversation,
        id: `conversation-${index}`,
        title: `conversation ${index}`,
      };
      invokeMock.mockImplementation(async (command: string) => {
        if (command === "get_messages") return [];
        if (command === "create_conversation") return nextConversation;
        throw new Error(`Unexpected IPC command: ${command}`);
      });
      const hook = renderHook(() =>
        useAcpChat({ profileId, projectDir, permissionMode: "request" }),
      );
      await act(async () => {
        expect(await hook.result.current.sendMessage(`message ${index}`)).toBe(true);
      });
      expect(activeAcpSessionCountForTests()).toBeLessThanOrEqual(1);
      hook.unmount();
      await waitFor(() => expect(activeAcpSessionCountForTests()).toBe(0));
    }
    expect(bridge.disconnectAcp).toHaveBeenCalledTimes(9);
  });

  it("cancels adapter startup before any turn is admitted", async () => {
    let finishConnect!: () => void;
    bridge.connectAcp.mockImplementation(
      () =>
        new Promise<AcpConnectResult>((resolve) => {
          finishConnect = () => resolve(connectResult);
        }),
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage("cancel startup");
    });
    await waitFor(() => expect(bridge.connectAcp).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.stopStreaming();
    });
    let accepted = true;
    await act(async () => {
      finishConnect();
      accepted = await pending;
    });
    expect(accepted).toBe(false);
    expect(bridge.cancelAcp).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
    });
    expect(bridge.beginAcpTurn).not.toHaveBeenCalled();
    expect(bridge.promptAcp).not.toHaveBeenCalled();
    expect(bridge.disconnectAcp).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
    });
  });

  it("clears cancelling state when adapter startup rejects after cancellation", async () => {
    let rejectConnect!: (error: Error) => void;
    bridge.connectAcp.mockImplementation(
      () =>
        new Promise<AcpConnectResult>((_resolve, reject) => {
          rejectConnect = reject;
        }),
    );
    bridge.cancelAcp.mockImplementation(async () => {
      rejectConnect(new Error("ACP startup was cancelled"));
    });
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage("cancel rejected startup");
    });
    await waitFor(() => expect(bridge.connectAcp).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.stopStreaming();
    });
    let accepted = true;
    await act(async () => {
      accepted = await pending;
    });

    expect(accepted).toBe(false);
    expect(result.current.isBusy).toBe(false);
    expect(result.current.status).toBe("cancelled");
    expect(bridge.beginAcpTurn).not.toHaveBeenCalled();
    expect(bridge.promptAcp).not.toHaveBeenCalled();
  });

  it("does not dispatch a turn cancelled while atomic admission is in flight", async () => {
    let finishAdmission!: () => void;
    bridge.beginAcpTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAdmission = () =>
            resolve({
              turnToken: "turn-token-1",
              message: {
                id: "message-1",
                conversation_id: conversation.id,
                role: "user",
                content: "cancel admission",
                reasoning_content: null,
                created_at: "2026-08-31T10:00:01.000Z",
              } satisfies DbMessage,
            });
        }),
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage("cancel admission");
    });
    await waitFor(() => expect(bridge.beginAcpTurn).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.stopStreaming();
    });
    let accepted = false;
    await act(async () => {
      finishAdmission();
      accepted = await pending;
    });

    expect(accepted).toBe(true);
    expect(bridge.abortAcpTurn).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
      turnToken: "turn-token-1",
    });
    expect(bridge.promptAcp).not.toHaveBeenCalled();
    expect(bridge.disconnectAcp).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
    });
    expect(result.current.isBusy).toBe(false);
    expect(result.current.status).toBe("cancelled");
  });

  it("fails closed when a cancelled pending admission cannot be aborted", async () => {
    let finishAdmission!: () => void;
    bridge.beginAcpTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAdmission = () =>
            resolve({
              turnToken: "turn-token-1",
              message: {
                id: "message-1",
                conversation_id: conversation.id,
                role: "user",
                content: "cancel admission",
                reasoning_content: null,
                created_at: "2026-08-31T10:00:01.000Z",
              } satisfies DbMessage,
            });
        }),
    );
    bridge.abortAcpTurn.mockRejectedValue(new Error("turn already dispatched"));
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage("cancel admission");
    });
    await waitFor(() => expect(bridge.beginAcpTurn).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.stopStreaming();
    });
    let accepted = true;
    await act(async () => {
      finishAdmission();
      accepted = await pending;
    });

    expect(accepted).toBe(false);
    expect(bridge.promptAcp).not.toHaveBeenCalled();
    expect(bridge.disconnectAcp).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
    });
    expect(result.current.isBusy).toBe(false);
    expect(result.current.status).toBe("cancelled");
  });

  it("does not admit a turn cancelled while image persistence is in flight", async () => {
    bridge.connectAcp.mockResolvedValue({
      ...connectResult,
      capabilities: {
        ...connectResult.capabilities,
        prompt: { image: true, audio: false, embeddedContext: false },
      },
    });
    let finishImageSave!: () => void;
    imageMocks.saveImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImageSave = () => resolve("/saved/image.png");
        }),
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage("cancel image", [
        { id: "image-1", mimeType: "image/png", base64: "aW1hZ2U=" },
      ]);
    });
    await waitFor(() => expect(imageMocks.saveImage).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.stopStreaming();
    });
    let accepted = true;
    await act(async () => {
      finishImageSave();
      accepted = await pending;
    });

    expect(accepted).toBe(false);
    expect(bridge.beginAcpTurn).not.toHaveBeenCalled();
    expect(bridge.promptAcp).not.toHaveBeenCalled();
    expect(result.current.isBusy).toBe(false);
    expect(result.current.status).toBe("cancelled");
  });

  it("cancels the active Rust prompt with its current generation and clears busy state", async () => {
    let finishPrompt!: () => void;
    bridge.promptAcp.mockImplementation(
      (_input: unknown, onEvent: (event: AcpEvent) => void) =>
        new Promise<AcpPromptResult>((resolve) => {
          onEvent(activeEvent({ type: "turn_started", sequence: 1, turnId: "turn-1" }));
          finishPrompt = () => {
            onEvent(
              activeEvent({
                type: "turn_cancelled",
                sequence: 2,
                turnId: "turn-1",
                result: { stopReason: "cancelled" },
              }),
            );
            resolve({ ...promptResult, stopReason: "cancelled" });
          };
        }),
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    let prompt!: Promise<boolean>;
    act(() => {
      prompt = result.current.sendMessage("cancel me");
    });
    await waitFor(() => expect(bridge.promptAcp).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.stopStreaming();
    });

    expect(bridge.cancelAcp).toHaveBeenCalledWith({
      conversationId: conversation.id,
      generation: 1,
    });
    expect(useStreamingStore.getState().streamingConvIds).not.toContain(
      conversation.id,
    );

    await act(async () => {
      finishPrompt();
      await prompt;
    });
  });

  it("surfaces adapter startup failure and leaves persistence retryable", async () => {
    bridge.connectAcp.mockRejectedValue(new Error("adapter executable not found"));
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    let accepted = true;
    await act(async () => {
      accepted = await result.current.sendMessage("hello");
    });

    expect(accepted).toBe(false);
    expect(result.current.error?.message).toContain("adapter executable not found");
    expect(bridge.promptAcp).not.toHaveBeenCalled();
    expect(useStreamingStore.getState().streamingConvIds).not.toContain(
      conversation.id,
    );
    expect(result.current.messages).toHaveLength(0);
  });

  it("requires an explicit profile and project and never switches an existing conversation", async () => {
    const { result, rerender } = renderHook(
      ({ selectedProfile, selectedProject }) =>
        useAcpChat({
          profileId: selectedProfile,
          projectDir: selectedProject,
          permissionMode: "request",
        }),
      { initialProps: { selectedProfile: null as string | null, selectedProject: null as string | null } },
    );

    await act(async () => {
      expect(await result.current.sendMessage("missing selections")).toBe(false);
    });
    expect(result.current.error?.message).toMatch(/select an agent profile/i);

    rerender({ selectedProfile: profileId, selectedProject: projectDir });
    await act(async () => {
      await result.current.loadConversation(conversation);
    });
    rerender({ selectedProfile: "different-profile", selectedProject: projectDir });

    await act(async () => {
      expect(await result.current.sendMessage("do not switch")).toBe(false);
    });
    expect(result.current.error?.message).toMatch(/uses profile profile-1/i);
    expect(bridge.connectAcp).not.toHaveBeenCalled();
  });

  it("continues the generation counter across a WebView reload", async () => {
    sessionStorage.setItem(
      `thechat:acp:generation:${conversation.id}`,
      "41",
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    await act(async () => {
      expect(await result.current.sendMessage("after reload")).toBe(true);
    });

    expect(bridge.connectAcp).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 42 }),
      expect.any(Function),
    );
  });

  it("reconnects after an adapter disconnects while idle", async () => {
    let sessionEvents: ((event: AcpEvent) => void) | undefined;
    bridge.connectAcp.mockImplementation(
      async (
        input: { generation: number },
        onEvent: (event: AcpEvent) => void,
      ) => {
        sessionEvents = onEvent;
        return { ...connectResult, generation: input.generation };
      },
    );
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );
    await act(async () => {
      await result.current.loadConversation(conversation);
    });

    await act(async () => {
      expect(await result.current.sendMessage("first")).toBe(true);
    });
    const settledRuntime = useAcpStore.getState().runtimes[conversation.id];
    expect(activeAcpSessionCountForTests()).toBe(1);
    expect(settledRuntime?.eventState.status).toBe("finished");
    act(() => {
      sessionEvents?.({
        type: "disconnected",
        conversationId: conversation.id,
        generation: settledRuntime!.generation,
        sequence: settledRuntime!.eventState.lastSequence + 1,
        reason: "adapter exited while idle",
      });
    });
    expect(
      useAcpStore.getState().runtimes[conversation.id]?.eventState.status,
    ).toBe("disconnected");
    expect(result.current.status).toBe("disconnected");
    expect(result.current.isBusy).toBe(false);
    await act(async () => {
      expect(await result.current.sendMessage("retry")).toBe(true);
    });

    expect(bridge.connectAcp).toHaveBeenCalledTimes(2);
    expect(bridge.connectAcp).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 2 }),
      expect.any(Function),
    );
  });

  it("reconnects with a new generation after a fatal adapter disconnect", async () => {
    let promptCount = 0;
    bridge.promptAcp.mockImplementation(
      async (input: { generation: number }, onEvent: (event: AcpEvent) => void) => {
        promptCount += 1;
        const turnId = `turn-${promptCount}`;
        onEvent({
          type: "turn_started",
          conversationId: conversation.id,
          generation: input.generation,
          sequence: promptCount * 10 + 1,
          turnId,
        });
        if (promptCount === 1) {
          onEvent({
            type: "disconnected",
            conversationId: conversation.id,
            generation: input.generation,
            sequence: promptCount * 10 + 2,
            turnId,
            reason: "adapter exited",
          });
          throw new Error("adapter exited");
        }
        onEvent({
          type: "turn_finished",
          conversationId: conversation.id,
          generation: input.generation,
          sequence: promptCount * 10 + 2,
          turnId,
          result: { stopReason: "end_turn" },
        });
        return { ...promptResult, generation: input.generation, turnId };
      },
    );
    bridge.connectAcp.mockImplementation(async (input: { generation: number }) => ({
      ...connectResult,
      generation: input.generation,
    }));
    const { result } = renderHook(() =>
      useAcpChat({ profileId, projectDir, permissionMode: "request" }),
    );

    await act(async () => {
      expect(await result.current.sendMessage("first")).toBe(false);
    });
    await act(async () => {
      expect(await result.current.sendMessage("retry")).toBe(true);
    });

    expect(bridge.connectAcp).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ generation: 1 }),
      expect.any(Function),
    );
    expect(bridge.connectAcp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ generation: 2 }),
      expect.any(Function),
    );
  });
});
