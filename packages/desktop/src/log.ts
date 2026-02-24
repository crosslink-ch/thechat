import {
  info as tauriInfo,
  error as tauriError,
  warn as tauriWarn,
  debug as tauriDebug,
  trace as tauriTrace,
} from "@tauri-apps/plugin-log";

// In production Tauri builds, @tauri-apps/plugin-log writes to platform-specific
// log files (~/Library/Logs on macOS, AppData on Windows, XDG on Linux).
// The wrappers below add console fallback for dev/test and a formatError helper
// so we always preserve stack traces.

function safeLog(tauriFn: (msg: string) => Promise<void>, consoleFn: (...args: unknown[]) => void, msg: string) {
  consoleFn(`[thechat] ${msg}`);
  try {
    tauriFn(msg).catch(() => {});
  } catch {
    // plugin not available (e.g. running outside Tauri shell in tests)
  }
}

export function info(msg: string) {
  safeLog(tauriInfo, console.info, msg);
}

export function error(msg: string) {
  safeLog(tauriError, console.error, msg);
}

export function warn(msg: string) {
  safeLog(tauriWarn, console.warn, msg);
}

export function debug(msg: string) {
  safeLog(tauriDebug, console.debug, msg);
}

export function trace(msg: string) {
  safeLog(tauriTrace, console.debug, msg);
}

/**
 * Format an unknown caught value into a string with stack trace preserved.
 * Use this instead of `String(e)` in catch blocks.
 */
export function formatError(e: unknown): string {
  if (e instanceof Error) {
    const parts = [e.message];
    if (e.stack) parts.push(e.stack);
    return parts.join("\n");
  }
  return String(e);
}
