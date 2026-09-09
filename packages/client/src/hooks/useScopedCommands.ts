import { useEffect, useRef } from "react";
import { useCommandsStore, type Command } from "../commands";

let scopedCommandOwnerSequence = 0;

export function useScopedCommands(commands: Command[]) {
  const ownerIdRef = useRef<string | null>(null);
  if (ownerIdRef.current === null) {
    ownerIdRef.current = `scoped-${++scopedCommandOwnerSequence}`;
  }

  useEffect(() => {
    const ownerId = ownerIdRef.current;
    if (!ownerId) return;

    useCommandsStore.getState().registerScopedCommands(ownerId, commands);
    return () => {
      useCommandsStore.getState().unregisterScopedCommands(ownerId);
    };
  }, [commands]);
}
