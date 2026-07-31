import {
  createTraceState,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import type { TraceContextCarrier } from "@thechat/shared";

const defaultTracer = trace.getTracer("thechat-desktop");
let testTracer: Tracer | null = null;
let provider: WebTracerProvider | null = null;

export interface DesktopSpanOptions {
  kind?: SpanKind;
  parentContext?: Context;
  recordException?: boolean;
}

export function setDesktopTracerForTests(tracer: Tracer | null) {
  testTracer = tracer;
}

export function initDesktopObservability() {
  if (provider) return;
  const endpoint =
    import.meta.env.VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (!endpoint) return;

  const exporter = observedExporter(new OTLPTraceExporter({ url: endpoint }));
  provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      ...parseResourceAttributes(import.meta.env.VITE_OTEL_RESOURCE_ATTRIBUTES),
      "service.name":
        import.meta.env.VITE_OTEL_SERVICE_NAME?.trim() || "thechat-desktop",
      "service.namespace": "thechat",
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: 250,
        exportTimeoutMillis: 5_000,
        maxQueueSize: 1_024,
        maxExportBatchSize: 128,
      }),
    ],
  });
  provider.register();

  window.addEventListener("pagehide", () => {
    void provider?.forceFlush();
  });
  if (import.meta.env.VITE_OTEL_E2E_FORCE_FLUSH === "true") {
    window.__thechatOtelForceFlush = forceFlushDesktopObservability;
  }
}

function observedExporter(delegate: OTLPTraceExporter): SpanExporter {
  if (import.meta.env.VITE_OTEL_E2E_FORCE_FLUSH === "true") {
    window.__thechatOtelExports = [];
  }
  return {
    export(spans: ReadableSpan[], resultCallback) {
      delegate.export(spans, (result) => {
        window.__thechatOtelExports?.push({
          spanCount: spans.length,
          code: result.code,
          ...(result.error ? { error: "export_failed" } : {}),
        });
        resultCallback(result);
      });
    },
    shutdown() {
      return delegate.shutdown();
    },
    forceFlush() {
      return delegate.forceFlush();
    },
  };
}

export async function forceFlushDesktopObservability() {
  await provider?.forceFlush();
}

export async function withDesktopSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span, spanContext: Context) => T | Promise<T>,
  options: DesktopSpanOptions = {},
): Promise<T> {
  const parentContext = options.parentContext ?? ROOT_CONTEXT;
  const span = (testTracer ?? defaultTracer).startSpan(
    name,
    {
      attributes,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    },
    parentContext,
  );
  const spanContext = trace.setSpan(parentContext, span);
  try {
    return await fn(span, spanContext);
  } catch (error) {
    if (!isAbortError(error)) {
      if (options.recordException !== false) {
        recordSanitizedException(span, error);
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    throw error;
  } finally {
    span.end();
  }
}

export function recordSanitizedException(span: Span, error: unknown) {
  span.recordException(safeException(error));
}

export function traceHeaders(spanContext: Context): Record<string, string> {
  const current = trace.getSpanContext(spanContext);
  if (!current || !isSpanContextValid(current)) return {};
  const traceFlags = current.traceFlags.toString(16).padStart(2, "0");
  const tracestate = current.traceState?.serialize();
  return {
    traceparent: `00-${current.traceId}-${current.spanId}-${traceFlags}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

export function traceContextCarrier(
  spanContext: Context,
): TraceContextCarrier | undefined {
  const headers = traceHeaders(spanContext);
  if (!headers.traceparent) return undefined;
  return {
    traceparent: headers.traceparent,
    ...(headers.tracestate ? { tracestate: headers.tracestate } : {}),
  };
}

export function contextFromRemoteTrace(
  carrier: TraceContextCarrier | undefined,
): Context {
  if (!carrier?.traceparent) return ROOT_CONTEXT;
  const match = carrier.traceparent.match(
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i,
  );
  if (!match || match[1]?.toLowerCase() === "ff") return ROOT_CONTEXT;
  const spanContext = {
    traceId: match[2]!.toLowerCase(),
    spanId: match[3]!.toLowerCase(),
    traceFlags: Number.parseInt(match[4]!, 16),
    isRemote: true,
    ...(carrier.tracestate
      ? { traceState: createTraceState(carrier.tracestate) }
      : {}),
  };
  return isSpanContextValid(spanContext)
    ? trace.setSpanContext(ROOT_CONTEXT, spanContext)
    : ROOT_CONTEXT;
}

function parseResourceAttributes(value: string | undefined) {
  const attributes: Record<string, string> = {};
  if (!value) return attributes;
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const attributeValue = pair.slice(separator + 1).trim();
    if (key && attributeValue) attributes[key] = attributeValue;
  }
  return attributes;
}

function isAbortError(error: unknown) {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function safeException(error: unknown) {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
      ? error.name
      : "Error";
  return { name, message: "operation_failed" };
}

declare global {
  interface Window {
    __thechatOtelForceFlush?: () => Promise<void>;
    __thechatOtelExports?: Array<{
      spanCount: number;
      code: number;
      error?: string;
    }>;
  }
}

export { SpanKind, SpanStatusCode };
