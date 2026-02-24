import { usePermissionModeStore } from "../stores/permission-mode";

export interface PermissionRequest {
  id: string;
  command: string;
  description: string;
  resolve: () => void;
  reject: (reason: string) => void;
}

type PermissionListener = (request: PermissionRequest) => void;

let listener: PermissionListener | null = null;
let nextId = 0;

export function onPermissionRequest(callback: PermissionListener): () => void {
  listener = callback;
  return () => {
    if (listener === callback) {
      listener = null;
    }
  };
}

const EDIT_TOOL_PREFIXES = ["write ", "edit ", "multiedit "];

export function requestPermission(info: {
  command: string;
  description: string;
}): Promise<void> {
  const mode = usePermissionModeStore.getState().mode;

  if (mode === "bypass") return Promise.resolve();
  if (
    mode === "allow-edits" &&
    EDIT_TOOL_PREFIXES.some((p) => info.command.startsWith(p))
  ) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (!listener) {
      reject(new Error("No permission handler registered"));
      return;
    }

    const request: PermissionRequest = {
      id: String(++nextId),
      command: info.command,
      description: info.description,
      resolve,
      reject: (reason: string) => reject(new Error(reason)),
    };

    listener(request);
  });
}
