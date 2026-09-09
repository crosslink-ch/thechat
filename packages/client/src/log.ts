import { isWeb } from "./platform/environment";
import { services } from "#platform-services";

// In production Tauri builds, @tauri-apps/plugin-log writes to platform-specific
// log files (~/Library/Logs on macOS, AppData on Windows, XDG on Linux).
// The wrappers below add console fallback for dev/test and a formatError helper
// so we always preserve stack traces.

function safeLog(tauriFn: (msg: string) => Promise<void>, consoleFn: (...args: unknown[]) => void, msg: string) {
  consoleFn(`[thechat] ${msg}`);
  if (isWeb) return;
  try {
    tauriFn(msg).catch(() => {});
  } catch {
    // plugin not available (e.g. running outside Tauri shell in tests)
  }
}

export function info(msg: string) {
  safeLog(msg => services.log("info", msg), console.info, msg);
}

export function error(msg: string) {
  safeLog(msg => services.log("error", msg), console.error, msg);
}

export function warn(msg: string) {
  safeLog(msg => services.log("warn", msg), console.warn, msg);
}

export function debug(msg: string) {
  safeLog(msg => services.log("debug", msg), console.debug, msg);
}

export function trace(msg: string) {
  safeLog(msg => services.log("trace", msg), console.debug, msg);
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
