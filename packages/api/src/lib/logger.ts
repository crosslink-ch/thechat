/**
 * Tiny structured logger used by API code paths that don't have access to the
 * Elysia per-request logger (e.g. fire-and-forget background work, webhook
 * delivery). Output is a single JSON line per call so it stays grep-friendly
 * and machine-parseable without dragging in a heavy logging dep.
 *
 * LOG_LEVEL=silent (or NODE_ENV=test with no LOG_LEVEL=debug override) silences
 * output so test runs stay clean.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "silent") return "error"; // silent floors at error
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  // Default: quiet during tests, info otherwise
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return "warn";
  }
  return "info";
}

function isSilenced(): boolean {
  return (process.env.LOG_LEVEL ?? "").toLowerCase() === "silent";
}

function emit(level: Level, component: string, msg: string, fields?: Record<string, unknown>) {
  if (isSilenced()) return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...fields,
  };

  // Use the matching console method so tooling that hooks console can route by
  // severity. Stringify ourselves so the line stays single-line JSON.
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}

export const log = {
  debug(component: string, msg: string, fields?: Record<string, unknown>) {
    emit("debug", component, msg, fields);
  },
  info(component: string, msg: string, fields?: Record<string, unknown>) {
    emit("info", component, msg, fields);
  },
  warn(component: string, msg: string, fields?: Record<string, unknown>) {
    emit("warn", component, msg, fields);
  },
  error(component: string, msg: string, fields?: Record<string, unknown>) {
    emit("error", component, msg, fields);
  },
};
