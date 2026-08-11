import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandsStore } from "../commands";
import {
  needsAttentionKvKey,
  scopeNeedsAttention,
  useNeedsAttentionStore,
} from "../stores/needs-attention";
import {
  NEEDS_ATTENTION_SHORTCUT,
  useNeedsAttentionCommand,
} from "./useNeedsAttentionCommand";
import { useKeybindings } from "./useKeybindings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(async () => {
  vi.clearAllMocks();
  const values: Record<string, string> = {};
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as { key?: string; value?: string } | undefined;
    const key = input?.key ?? "";
    if (command === "kv_get") return values[key] ?? null;
    if (command === "kv_set" && input?.value !== undefined) {
      values[key] = input.value;
      return null;
    }
    if (command === "kv_delete") {
      delete values[key];
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  useCommandsStore.setState({
    globalCommands: [],
    scopedCommands: {},
    commands: [],
  });
  useNeedsAttentionStore.getState().resetForTests();
  await useNeedsAttentionStore.getState().initialize("user-1");
});

describe("useNeedsAttentionCommand", () => {
  it("registers the command and shortcut for the active channel", async () => {
    renderHook(() =>
      useNeedsAttentionCommand({
        userId: "user-1",
        conversationId: "channel-1",
      }),
    );

    const command = useCommandsStore
      .getState()
      .commands.find((candidate) => candidate.id === "needs-attention");
    expect(command).toMatchObject({
      label: "Needs Attention",
      shortcut: NEEDS_ATTENTION_SHORTCUT,
      keybinding: { prefix: "C-x", key: "m" },
    });

    act(() => command?.execute());
    await waitFor(() =>
      expect(
        scopeNeedsAttention(
          useNeedsAttentionStore.getState().scopes,
          "channel-1",
        ),
      ).toBe(true),
    );
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("kv_set", {
      key: needsAttentionKvKey("user-1"),
      value: expect.stringContaining("channel-1"),
    });
  });

  it("targets the selected Hermes task and changes to a clear command", async () => {
    renderHook(() =>
      useNeedsAttentionCommand({
        userId: "user-1",
        conversationId: "dm-1",
        threadId: "task-1",
      }),
    );

    act(() => {
      useCommandsStore
        .getState()
        .commands.find((candidate) => candidate.id === "needs-attention")
        ?.execute();
    });

    await waitFor(() =>
      expect(
        useCommandsStore
          .getState()
          .commands.find((candidate) => candidate.id === "needs-attention")
          ?.label,
      ).toBe("Clear Needs Attention"),
    );
    expect(
      scopeNeedsAttention(
        useNeedsAttentionStore.getState().scopes,
        "dm-1",
        "task-1",
      ),
    ).toBe(true);
  });

  it("toggles the current scope from the C-x m key sequence", async () => {
    renderHook(() => {
      useKeybindings({
        onPermissionAllow: () => undefined,
        onPermissionDeny: () => undefined,
        onPermissionDenyWithFeedback: () => undefined,
        handleRegistryCommands: true,
      });
      useNeedsAttentionCommand({
        userId: "user-1",
        conversationId: "dm-1",
        threadId: "task-1",
      });
    });

    await waitFor(() => {
      expect(useCommandsStore.getState().commands[0]?.enabled).toBe(true);
    });

    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    fireEvent.keyDown(window, { key: "m" });

    await waitFor(() => {
      expect(
        scopeNeedsAttention(
          useNeedsAttentionStore.getState().scopes,
          "dm-1",
          "task-1",
        ),
      ).toBe(true);
    });
  });
});
