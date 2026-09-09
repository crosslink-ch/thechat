import { queryClient } from "./query-client";

let generation = 0;
const resets = new Set<() => void>();
const expirations = new Set<() => void>();
export function onSessionExpired(expire: () => void) {
  expirations.add(expire);
  return () => { expirations.delete(expire); };
}
export function expireBrowserSession(expectedGeneration = generation) {
  if (expectedGeneration !== generation) return;
  resetPrivateSession();
  for (const expire of expirations) expire();
}
/** A generation fences network completions, even when both sessions have null tokens. */
export function sessionGeneration() { return generation; }
export function onSessionReset(reset: () => void) {
  resets.add(reset);
  return () => { resets.delete(reset); };
}
export function resetPrivateSession() {
  generation += 1;
  queryClient.clear();
  for (const reset of resets) reset();
}
