import { create } from "zustand";
import { usePermissionModeStore } from "../stores/permission-mode";

export interface PermissionRequest {
  id: string;
  convId: string;
  command: string;
  description: string;
  resolve: () => void;
  reject: (reason: string) => void;
}

interface PermissionStoreState {
  /** Queue of pending permission requests per conversation */
  pending: Record<string, PermissionRequest[]>;
}

export const usePermissionStore = create<PermissionStoreState>()(() => ({
  pending: {},
}));

let nextId = 0;

const EDIT_TOOL_PREFIXES = ["write ", "edit ", "multiedit "];

export function requestPermission(info: {
  command: string;
  description: string;
  convId?: string;
}): Promise<void> {
  const mode = usePermissionModeStore.getState().mode;

  if (mode === "bypass") return Promise.resolve();
  if (
    mode === "allow-edits" &&
    EDIT_TOOL_PREFIXES.some((p) => info.command.startsWith(p))
  ) {
    return Promise.resolve();
  }

  const convId = info.convId ?? "_default";
  const id = String(++nextId);

  return new Promise<void>((resolve, reject) => {
    const request: PermissionRequest = {
      id,
      convId,
      command: info.command,
      description: info.description,
      resolve: () => {
        removeRequest(convId, id);
        resolve();
      },
      reject: (reason: string) => {
        removeRequest(convId, id);
        reject(new Error(reason));
      },
    };

    usePermissionStore.setState((s) => ({
      pending: {
        ...s.pending,
        [convId]: [...(s.pending[convId] ?? []), request],
      },
    }));
  });
}

function removeRequest(convId: string, id: string) {
  usePermissionStore.setState((s) => {
    const queue = (s.pending[convId] ?? []).filter((r) => r.id !== id);
    if (queue.length === 0) {
      const { [convId]: _, ...rest } = s.pending;
      return { pending: rest };
    }
    return { pending: { ...s.pending, [convId]: queue } };
  });
}
