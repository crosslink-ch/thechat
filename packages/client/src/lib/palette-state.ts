import { create } from "zustand";
import type { PaletteMode } from "./search";

/**
 * Open state of the quick switcher / command palette. Kept apart from the
 * component so layout code can ask "is it open?" without importing it.
 */
export const usePaletteState = create(() => ({
  open: false,
  mode: "all" as PaletteMode,
  initialQuery: "",
  /** Bumped on every open, so reopening resets the input. */
  session: 0,
}));

export const isPaletteOpen = () => usePaletteState.getState().open;

export function openPalette(mode: PaletteMode = "all", initialQuery = "") {
  usePaletteState.setState((state) => ({ open: true, mode, initialQuery, session: state.session + 1 }));
}
