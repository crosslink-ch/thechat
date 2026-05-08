import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

export const tracer = trace.getTracer("thechat-api");

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
