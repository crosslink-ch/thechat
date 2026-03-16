import { create } from "zustand";

/**
 * Tiny store to coordinate "please focus the input bar" requests.
 *
 * Any UI surface (command palette, pickers, modals) can call
 * `requestInputBarFocus()` after it closes.  The InputBar component
 * watches `focusTick` and re-focuses whenever it bumps.
 */
interface InputFocusStore {
  focusTick: number;
}

export const useInputFocusStore = create<InputFocusStore>()(() => ({
  focusTick: 0,
}));

export const requestInputBarFocus = () =>
  useInputFocusStore.setState((s) => ({ focusTick: s.focusTick + 1 }));
