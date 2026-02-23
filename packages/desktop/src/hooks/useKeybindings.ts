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

  const cxPrefixRef = useRef(false);
  const cxTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const commands = useCommandsStore.getState().commands;

      // C-x prefix mode
      if (cxPrefixRef.current) {
        cxPrefixRef.current = false;
        clearTimeout(cxTimeoutRef.current);

        // Permission actions take priority in C-x prefix
        if (e.key === "a" && actionsRef.current.onPermissionAllow) {
          e.preventDefault();
          actionsRef.current.onPermissionAllow();
          return;
        }
        if (e.key === "d" && actionsRef.current.onPermissionDeny) {
          e.preventDefault();
          actionsRef.current.onPermissionDeny();
          return;
        }
        if (e.key === "f" && actionsRef.current.onPermissionDenyWithFeedback) {
          e.preventDefault();
          actionsRef.current.onPermissionDenyWithFeedback();
          return;
        }

        // Check registry for C-x prefixed commands
        for (const cmd of commands) {
          if (cmd.keybinding?.prefix === "C-x" && cmd.keybinding.key === e.key) {
            e.preventDefault();
            cmd.execute();
            return;
          }
        }

        // Any other key: cancel prefix silently
        return;
      }

      // Enter C-x prefix
      if (e.ctrlKey && e.key === "x") {
        e.preventDefault();
        cxPrefixRef.current = true;
        cxTimeoutRef.current = setTimeout(() => {
          cxPrefixRef.current = false;
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
      clearTimeout(cxTimeoutRef.current);
    };
  }, []);
}
