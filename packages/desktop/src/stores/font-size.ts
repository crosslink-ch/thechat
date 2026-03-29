import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

const KV_KEY = "ui_font_size";
const DEFAULT = 14;
const MIN = 10;
const MAX = 24;
const STEP = 1;

interface FontSizeStore {
  size: number;
  initialize: () => Promise<void>;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
}

function apply(size: number) {
  document.documentElement.style.fontSize = `${size}px`;
}

function persist(size: number) {
  void invoke("kv_set", { key: KV_KEY, value: String(size) });
}

export const useFontSizeStore = create<FontSizeStore>()((set, get) => ({
  size: DEFAULT,

  initialize: async () => {
    const saved = await invoke<string | null>("kv_get", { key: KV_KEY });
    const size = saved ? Math.min(MAX, Math.max(MIN, Number(saved) || DEFAULT)) : DEFAULT;
    apply(size);
    set({ size });
  },

  increase: () => {
    const next = Math.min(MAX, get().size + STEP);
    apply(next);
    persist(next);
    set({ size: next });
  },

  decrease: () => {
    const next = Math.max(MIN, get().size - STEP);
    apply(next);
    persist(next);
    set({ size: next });
  },

  reset: () => {
    apply(DEFAULT);
    persist(DEFAULT);
    set({ size: DEFAULT });
  },
}));
