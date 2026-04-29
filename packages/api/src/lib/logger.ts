import { createPinoLogger } from "@bogeychan/elysia-logger";

type Fields = Record<string, unknown>;

function defaultLogLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return "silent";
  }
  return "info";
}

/**
 * Shared Pino logger used by the Elysia logger plugin and standalone service
 * code such as fire-and-forget webhook delivery.
 */
export const pinoLog = createPinoLogger({
  level: defaultLogLevel(),
});

export const log = {
  debug(component: string, msg: string, fields?: Fields) {
    pinoLog.debug({ component, ...fields }, msg);
  },
  info(component: string, msg: string, fields?: Fields) {
    pinoLog.info({ component, ...fields }, msg);
  },
  warn(component: string, msg: string, fields?: Fields) {
    pinoLog.warn({ component, ...fields }, msg);
  },
  error(component: string, msg: string, fields?: Fields) {
    pinoLog.error({ component, ...fields }, msg);
  },
};
