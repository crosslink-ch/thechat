import { create } from "zustand";

export type PermissionMode = "request" | "allow-edits" | "bypass";

interface PermissionModeStore {
  mode: PermissionMode;
  setMode: (mode: PermissionMode) => void;
}

export const usePermissionModeStore = create<PermissionModeStore>()((set) => ({
  mode: "request",
  setMode: (mode) => set({ mode }),
}));
