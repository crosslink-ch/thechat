import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandsStore, type Command } from "../commands";
import { useScopedCommands } from "./useScopedCommands";

function command(id: string, overrides: Partial<Command> = {}): Command {
  return {
    id,
    label: id,
    shortcut: null,
    keybinding: null,
    execute: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useCommandsStore.setState({
    globalCommands: [],
    scopedCommands: {},
    commands: [],
  });
});

describe("useScopedCommands", () => {
  it("registers scoped commands ahead of global commands by default", () => {
    const globalCommand = command("global-command", { priority: 0 });
    const scopedCommand = command("hermes.new-session");
    useCommandsStore.getState().setCommands([globalCommand]);

    const { unmount } = renderHook(() => useScopedCommands([scopedCommand]));

    expect(useCommandsStore.getState().commands.map((cmd) => cmd.id)).toEqual([
      "hermes.new-session",
      "global-command",
    ]);

    unmount();
    expect(useCommandsStore.getState().commands.map((cmd) => cmd.id)).toEqual(["global-command"]);
  });

  it("updates scoped commands when the hook input changes", () => {
    const first = command("first");
    const second = command("second");

    const { rerender } = renderHook(
      ({ commands }: { commands: Command[] }) => useScopedCommands(commands),
      { initialProps: { commands: [first] } },
    );

    expect(useCommandsStore.getState().commands.map((cmd) => cmd.id)).toEqual(["first"]);

    rerender({ commands: [second] });

    expect(useCommandsStore.getState().commands.map((cmd) => cmd.id)).toEqual(["second"]);
  });
});
