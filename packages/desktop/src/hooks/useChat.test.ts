import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat } from "./useChat";
import { useStreamingStore } from "../stores/streaming";

const invokeMock = vi.hoisted(() => vi.fn());
const runChatLoopMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../core/loop", () => ({
  runChatLoop: runChatLoopMock,
}));

describe("useChat cwd resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStreamingStore.setState({ streamingConvIds: new Set() });

    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_config") return Promise.resolve({ api_key: "k", model: "m", provider: "openrouter" });
      if (cmd === "save_message") {
        const role = (args?.role as string) ?? "assistant";
        const conversationId = (args?.conversationId as string) ?? "conv-1";
        return Promise.resolve({
          id: role === "user" ? "msg-user" : "msg-assistant",
          conversation_id: conversationId,
          role,
          content: role === "user" ? (args?.content as string) ?? "" : "ok",
          reasoning_content: null,
          created_at: new Date().toISOString(),
        });
      }
      if (cmd === "create_conversation") {
        return Promise.resolve({
          id: "conv-1",
          title: "t",
          project_dir: (args?.projectDir as string | null) ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      if (cmd === "get_messages") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    runChatLoopMock.mockResolvedValue(undefined);
  });

  it("uses loaded conversation.project_dir instead of current app projectDir", async () => {
    const { result } = renderHook(() => useChat({ projectDir: "/projects/qwen3-tts" }));

    await act(async () => {
      await result.current.loadConversation({
        id: "conv-1",
        title: "old aihub chat",
        project_dir: "/projects/aihub",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    });

    await act(async () => {
      await result.current.sendMessage("run pwd");
    });

    expect(runChatLoopMock).toHaveBeenCalledTimes(1);
    const callArg = runChatLoopMock.mock.calls[0][0];
    expect(callArg.cwd).toBe("/projects/aihub");
  });
});
