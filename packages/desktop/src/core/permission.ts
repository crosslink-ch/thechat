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
  /** Pending permission requests keyed by conversation ID */
  pending: Record<string, PermissionRequest>;
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

  return new Promise<void>((resolve, reject) => {
    const request: PermissionRequest = {
      id: String(++nextId),
      convId,
      command: info.command,
      description: info.description,
      resolve: () => {
        usePermissionStore.setState((s) => {
          const { [convId]: _, ...rest } = s.pending;
          return { pending: rest };
        });
        resolve();
      },
      reject: (reason: string) => {
        usePermissionStore.setState((s) => {
          const { [convId]: _, ...rest } = s.pending;
          return { pending: rest };
        });
        reject(new Error(reason));
      },
    };

    usePermissionStore.setState((s) => ({
      pending: { ...s.pending, [convId]: request },
    }));
  });
}
