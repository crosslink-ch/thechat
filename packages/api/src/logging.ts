import { context, isSpanContextValid, trace } from "@opentelemetry/api";
import { createPinoLogger } from "@bogeychan/elysia-logger";

export type ApplicationLogger = ReturnType<typeof createPinoLogger>;

export function createApplicationLogger(
  level = process.env.LOG_LEVEL ?? "info",
): ApplicationLogger {
  return createPinoLogger({
    level,
    mixin() {
      const spanContext = trace.getSpan(context.active())?.spanContext();
      if (!spanContext || !isSpanContextValid(spanContext)) return {};
      return {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: spanContext.traceFlags.toString(16).padStart(2, "0"),
      };
    },
  });
}

export const log: ApplicationLogger = createApplicationLogger();
