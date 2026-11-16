import { create } from "zustand";

/**
 * Tiny store to coordinate "please focus the input bar" requests.
 *
 * Any UI surface (command palette, pickers, modals) can call
 * `requestInputBarFocus()` after it closes. The InputBar component watches
 * `focusTick` and takes each request once (`claimInputBarFocus`), so a
 * composer that opens later, such as another conversation's, does not act on
 * an old request.
 */
interface InputFocusStore {
  focusTick: number;
  /** The newest request a composer has taken. */
  claimedTick: number;
}

export const useInputFocusStore = create<InputFocusStore>()(() => ({
  focusTick: 0,
  claimedTick: 0,
}));

export const requestInputBarFocus = () =>
  useInputFocusStore.setState((s) => ({ focusTick: s.focusTick + 1 }));

/** Take the pending focus request; true for exactly one caller per request. */
export function claimInputBarFocus(): boolean {
  const { focusTick, claimedTick } = useInputFocusStore.getState();
  if (focusTick === 0 || focusTick === claimedTick) return false;
  useInputFocusStore.setState({ claimedTick: focusTick });
  return true;
}
