import { createPinoLogger } from "@bogeychan/elysia-logger";

export type ApplicationLogger = ReturnType<typeof createPinoLogger>;

export function createApplicationLogger(
  level = process.env.LOG_LEVEL ?? "info",
): ApplicationLogger {
  return createPinoLogger({ level });
}

export const log: ApplicationLogger = createApplicationLogger();
