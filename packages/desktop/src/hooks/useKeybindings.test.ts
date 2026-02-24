import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useCommandsStore, type Command } from "../commands";
import { useKeybindings } from "./useKeybindings";

function makeCommand(overrides: Partial<Command> & { id: string }): Command {
  return {
    label: overrides.id,
    shortcut: null,
    keybinding: null,
    execute: vi.fn(),
    ...overrides,
  };
}

function seedCommands(commands: Command[]) {
  useCommandsStore.setState({ commands });
}

const noopActions = {
  onPermissionAllow: null,
  onPermissionDeny: null,
  onPermissionDenyWithFeedback: null,
};

function pressKey(key: string, opts: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...opts });
}

function pressCxChord(key: string) {
  pressKey("x", { ctrlKey: true });
  pressKey(key);
}

beforeEach(() => {
  useCommandsStore.setState({ commands: [] });
});

describe("useKeybindings", () => {
  describe("non-prefix commands", () => {
    it("dispatches a Ctrl+key command when handleRegistryCommands is true", () => {
      const cmd = makeCommand({ id: "toggle-palette", keybinding: { key: "p", ctrl: true } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, handleRegistryCommands: true }));
      pressKey("p", { ctrlKey: true });

      expect(cmd.execute).toHaveBeenCalledOnce();
    });

    it("does NOT dispatch non-prefix commands when handleRegistryCommands is false", () => {
      const cmd = makeCommand({ id: "toggle-palette", keybinding: { key: "p", ctrl: true } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressKey("p", { ctrlKey: true });

      expect(cmd.execute).not.toHaveBeenCalled();
    });

    it("matches metaKey as an alias for ctrlKey", () => {
      const cmd = makeCommand({ id: "toggle-palette", keybinding: { key: "p", ctrl: true } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, handleRegistryCommands: true }));
      pressKey("p", { metaKey: true });

      expect(cmd.execute).toHaveBeenCalledOnce();
    });

    it("does not fire when modifier mismatch (ctrl expected, none pressed)", () => {
      const cmd = makeCommand({ id: "toggle-palette", keybinding: { key: "p", ctrl: true } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, handleRegistryCommands: true }));
      pressKey("p");

      expect(cmd.execute).not.toHaveBeenCalled();
    });

    it("does not fire when extra modifier present (ctrl pressed, not expected)", () => {
      const cmd = makeCommand({ id: "something", keybinding: { key: "k" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, handleRegistryCommands: true }));
      pressKey("k", { ctrlKey: true });

      expect(cmd.execute).not.toHaveBeenCalled();
    });
  });

  describe("C-x prefix commands", () => {
    it("dispatches a C-x prefixed command", () => {
      const cmd = makeCommand({ id: "new-chat", keybinding: { prefix: "C-x", key: "n" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressCxChord("n");

      expect(cmd.execute).toHaveBeenCalledOnce();
    });

    it("unknown key after C-x cancels prefix silently", () => {
      const cmd = makeCommand({ id: "new-chat", keybinding: { prefix: "C-x", key: "n" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      // Press C-x then 'z' (unknown), then 'n' outside prefix
      pressKey("x", { ctrlKey: true });
      pressKey("z");
      pressKey("n");

      expect(cmd.execute).not.toHaveBeenCalled();
    });

    it("prefix times out after 2 seconds", () => {
      vi.useFakeTimers();
      const cmd = makeCommand({ id: "new-chat", keybinding: { prefix: "C-x", key: "n" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressKey("x", { ctrlKey: true });
      vi.advanceTimersByTime(2100);
      pressKey("n");

      expect(cmd.execute).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("dispatches a multi-key prefix command (C-x c n)", () => {
      const cmd = makeCommand({ id: "deep-cmd", keybinding: { prefix: "C-x c", key: "n" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressKey("x", { ctrlKey: true });
      pressKey("c");
      pressKey("n");

      expect(cmd.execute).toHaveBeenCalledOnce();
    });

    it("multi-key prefix does not fire single-key command on intermediate key", () => {
      const singleCmd = makeCommand({ id: "single", keybinding: { prefix: "C-x", key: "n" } });
      const multiCmd = makeCommand({ id: "multi", keybinding: { prefix: "C-x c", key: "n" } });
      seedCommands([singleCmd, multiCmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressKey("x", { ctrlKey: true });
      pressKey("c"); // extends to "C-x c", not a match for singleCmd
      pressKey("n"); // matches multiCmd

      expect(singleCmd.execute).not.toHaveBeenCalled();
      expect(multiCmd.execute).toHaveBeenCalledOnce();
    });

    it("dispatches a 3-level prefix command (C-x c b n)", () => {
      const cmd = makeCommand({ id: "deep-3", keybinding: { prefix: "C-x c b", key: "n" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressKey("x", { ctrlKey: true });
      pressKey("c");
      pressKey("b");
      pressKey("n");

      expect(cmd.execute).toHaveBeenCalledOnce();
    });

    it("multi-key prefix times out if second key not pressed in time", () => {
      vi.useFakeTimers();
      const cmd = makeCommand({ id: "deep-cmd", keybinding: { prefix: "C-x c", key: "n" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressKey("x", { ctrlKey: true });
      pressKey("c"); // extends to "C-x c"
      vi.advanceTimersByTime(2100);
      pressKey("n");

      expect(cmd.execute).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("permission action priority", () => {
    it("C-x a fires onPermissionAllow instead of registry command on key 'a'", () => {
      const allow = vi.fn();
      const cmd = makeCommand({ id: "some-a-cmd", keybinding: { prefix: "C-x", key: "a" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, onPermissionAllow: allow }));
      pressCxChord("a");

      expect(allow).toHaveBeenCalledOnce();
      expect(cmd.execute).not.toHaveBeenCalled();
    });

    it("C-x d fires onPermissionDeny instead of registry command on key 'd'", () => {
      const deny = vi.fn();
      const cmd = makeCommand({ id: "some-d-cmd", keybinding: { prefix: "C-x", key: "d" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, onPermissionDeny: deny }));
      pressCxChord("d");

      expect(deny).toHaveBeenCalledOnce();
      expect(cmd.execute).not.toHaveBeenCalled();
    });

    it("C-x f fires onPermissionDenyWithFeedback instead of registry command on key 'f'", () => {
      const feedback = vi.fn();
      const cmd = makeCommand({ id: "some-f-cmd", keybinding: { prefix: "C-x", key: "f" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions, onPermissionDenyWithFeedback: feedback }));
      pressCxChord("f");

      expect(feedback).toHaveBeenCalledOnce();
      expect(cmd.execute).not.toHaveBeenCalled();
    });

    it("C-x a falls through to registry when onPermissionAllow is null", () => {
      const cmd = makeCommand({ id: "some-a-cmd", keybinding: { prefix: "C-x", key: "a" } });
      seedCommands([cmd]);

      renderHook(() => useKeybindings({ ...noopActions }));
      pressCxChord("a");

      expect(cmd.execute).toHaveBeenCalledOnce();
    });
  });

  describe("cleanup", () => {
    it("removes listener on unmount", () => {
      const cmd = makeCommand({ id: "toggle-palette", keybinding: { key: "p", ctrl: true } });
      seedCommands([cmd]);

      const { unmount } = renderHook(() =>
        useKeybindings({ ...noopActions, handleRegistryCommands: true }),
      );
      unmount();
      pressKey("p", { ctrlKey: true });

      expect(cmd.execute).not.toHaveBeenCalled();
    });
  });
});
