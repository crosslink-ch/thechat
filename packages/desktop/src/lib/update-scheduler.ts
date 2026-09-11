import { useUpdaterStore } from "../stores/updater";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_THROTTLE_MS = 5 * 60 * 1000;

/** Discover updates independently of authentication; retain known updates. */
export function startUpdateChecks(): () => void {
  let stopped = false;
  let lastCheckAt = -Infinity;
  let retryInitialFailureOnOnline = false;

  const check = async (reason: "initial" | "scheduled" | "online") => {
    const state = useUpdaterStore.getState();
    if (stopped || state.update || state.checking || state.downloading || state.installing) return;
    const earlyOnlineRetry = reason === "online" && retryInitialFailureOnOnline;
    if (!earlyOnlineRetry && Date.now() - lastCheckAt < CHECK_THROTTLE_MS) return;
    lastCheckAt = Date.now();
    retryInitialFailureOnOnline = false;
    try {
      await state.checkForUpdates();
      // Reconnection gets one early retry when startup ran offline. Subsequent
      // failures still obey the throttle, even if online events arrive in bursts.
      if (reason === "initial") retryInitialFailureOnOnline = Boolean(useUpdaterStore.getState().error);
    } catch {
      // The store normally reports errors in state; keep the timer alive even
      // if a check unexpectedly rejects.
      if (reason === "initial") retryInitialFailureOnOnline = true;
    }
  };

  const scheduledCheck = () => { void check("scheduled"); };
  const onlineCheck = () => { void check("online"); };
  void check("initial");
  const timer = window.setInterval(scheduledCheck, CHECK_INTERVAL_MS);
  window.addEventListener("focus", scheduledCheck);
  window.addEventListener("online", onlineCheck);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("focus", scheduledCheck);
    window.removeEventListener("online", onlineCheck);
  };
}
