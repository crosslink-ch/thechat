import { useEffect, useRef } from "react";

interface KeybindingActions {
  onNewChat: () => void;
  onPaletteToggle: () => void;
  onPermissionAllow: (() => void) | null;
  onPermissionDeny: (() => void) | null;
}

export function useKeybindings(actions: KeybindingActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const cxPrefixRef = useRef(false);
  const cxTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+P: toggle command palette
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        actionsRef.current.onPaletteToggle();
        return;
      }

      // C-x prefix mode
      if (cxPrefixRef.current) {
        cxPrefixRef.current = false;
        clearTimeout(cxTimeoutRef.current);
        if (e.key === "n") {
          e.preventDefault();
          actionsRef.current.onNewChat();
        } else if (e.key === "a" && actionsRef.current.onPermissionAllow) {
          e.preventDefault();
          actionsRef.current.onPermissionAllow();
        } else if (e.key === "d" && actionsRef.current.onPermissionDeny) {
          e.preventDefault();
          actionsRef.current.onPermissionDeny();
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      clearTimeout(cxTimeoutRef.current);
    };
  }, []);
}
