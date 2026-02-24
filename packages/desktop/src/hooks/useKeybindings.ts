import { useEffect, useRef } from "react";
import { useCommandsStore, type Keybinding } from "../commands";

interface KeybindingActions {
  onPermissionAllow: (() => void) | null;
  onPermissionDeny: (() => void) | null;
  onPermissionDenyWithFeedback: (() => void) | null;
  handleRegistryCommands?: boolean;
}

function matchesKeybinding(e: KeyboardEvent, kb: Keybinding): boolean {
  if (e.key.toLowerCase() !== kb.key.toLowerCase()) return false;
  if (kb.ctrl && !(e.ctrlKey || e.metaKey)) return false;
  if (!kb.ctrl && (e.ctrlKey || e.metaKey)) return false;
  if (kb.shift && !e.shiftKey) return false;
  if (!kb.shift && e.shiftKey) return false;
  return true;
}

export function useKeybindings(actions: KeybindingActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const prefixRef = useRef<string | null>(null);
  const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const commands = useCommandsStore.getState().commands;

      // Prefix mode (C-x ...)
      if (prefixRef.current !== null) {
        clearTimeout(prefixTimeoutRef.current);
        const currentPrefix = prefixRef.current;

        // Permission actions take priority when prefix is exactly "C-x"
        if (currentPrefix === "C-x") {
          if (e.key === "a" && actionsRef.current.onPermissionAllow) {
            e.preventDefault();
            prefixRef.current = null;
            actionsRef.current.onPermissionAllow();
            return;
          }
          if (e.key === "d" && actionsRef.current.onPermissionDeny) {
            e.preventDefault();
            prefixRef.current = null;
            actionsRef.current.onPermissionDeny();
            return;
          }
          if (e.key === "f" && actionsRef.current.onPermissionDenyWithFeedback) {
            e.preventDefault();
            prefixRef.current = null;
            actionsRef.current.onPermissionDenyWithFeedback();
            return;
          }
        }

        // Check for exact match: command with prefix === currentPrefix and key === e.key
        for (const cmd of commands) {
          if (cmd.keybinding?.prefix === currentPrefix && cmd.keybinding.key === e.key) {
            e.preventDefault();
            prefixRef.current = null;
            cmd.execute();
            return;
          }
        }

        // Check if any command's prefix extends the current sequence
        const extended = currentPrefix + " " + e.key;
        const hasExtension = commands.some(
          (cmd) => cmd.keybinding?.prefix === extended,
        );
        if (hasExtension) {
          e.preventDefault();
          prefixRef.current = extended;
          prefixTimeoutRef.current = setTimeout(() => {
            prefixRef.current = null;
          }, 2000);
          return;
        }

        // No match — cancel prefix silently
        prefixRef.current = null;
        return;
      }

      // Enter C-x prefix
      if (e.ctrlKey && e.key === "x") {
        e.preventDefault();
        prefixRef.current = "C-x";
        prefixTimeoutRef.current = setTimeout(() => {
          prefixRef.current = null;
        }, 2000);
        return;
      }

      // Non-prefix registry commands (only handled by root to avoid double-fire)
      if (actionsRef.current.handleRegistryCommands) {
        for (const cmd of commands) {
          if (cmd.keybinding && !cmd.keybinding.prefix && matchesKeybinding(e, cmd.keybinding)) {
            e.preventDefault();
            cmd.execute();
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      clearTimeout(prefixTimeoutRef.current);
    };
  }, []);
}
