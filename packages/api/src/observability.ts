import {
  context,
  createTraceState,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const defaultTracer = trace.getTracer("thechat-api");
let testTracer: Tracer | null = null;

let tracerProvider: NodeTracerProvider | null = null;
let initPromise: Promise<void> | null = null;

export async function initObservability(defaultServiceName = "thechat-api") {
  if (process.env.THECHAT_OTEL_ENABLED === "false") return;
  if (tracerProvider) return;
  if (initPromise) return initPromise;

  initPromise = Promise.resolve().then(() => {
    const endpoint = resolveTraceEndpoint();
    if (!endpoint) return;

    const resourceAttributes = {
      ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
      "service.name":
        process.env.OTEL_SERVICE_NAME?.trim() || defaultServiceName,
      "service.namespace":
        process.env.OTEL_SERVICE_NAMESPACE?.trim() || "thechat",
    };
    const exporter = new OTLPTraceExporter({ url: endpoint });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes(resourceAttributes),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    provider.register();
    tracerProvider = provider;
  });

  return initPromise;
}

export async function shutdownObservability() {
  const provider = tracerProvider;
  tracerProvider = null;
  initPromise = null;
  await provider?.shutdown();
}

export interface TraceContextCarrier {
  traceparent: string;
  tracestate?: string;
}

export interface WithSpanOptions {
  kind?: SpanKind;
  parentContext?: Context;
  links?: Link[];
  recordException?: boolean;
  startTime?: Date;
}

export function setTracerForTests(tracer: Tracer | null) {
  testTracer = tracer;
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T | Promise<T>,
  options: WithSpanOptions = {},
): Promise<T> {
  const parentContext = options.parentContext ?? context.active();
  return (testTracer ?? defaultTracer).startActiveSpan(
    name,
    {
      attributes,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.links ? { links: options.links } : {}),
      ...(options.startTime ? { startTime: options.startTime } : {}),
    },
    parentContext,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        if (options.recordException !== false) {
          span.recordException(safeException(error));
        }
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function activeTraceContext(): TraceContextCarrier | undefined {
  return traceContextFromContext(context.active());
}

export function traceContextFromContext(
  sourceContext: Context,
): TraceContextCarrier | undefined {
  const current = trace.getSpanContext(sourceContext);
  if (!current || !isSpanContextValid(current)) return undefined;
  const traceFlags = current.traceFlags.toString(16).padStart(2, "0");
  const tracestate = current.traceState?.serialize();
  return {
    traceparent: `00-${current.traceId}-${current.spanId}-${traceFlags}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

export function contextFromTraceContext(
  carrier: TraceContextCarrier | undefined,
): Context {
  if (!carrier?.traceparent) return ROOT_CONTEXT;
  const match = carrier.traceparent.match(
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i,
  );
  if (!match) return ROOT_CONTEXT;
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

export function contextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): Context {
  const traceparent = headerValue(headers, "traceparent");
  if (!traceparent) return ROOT_CONTEXT;
  const tracestate = headerValue(headers, "tracestate");
  return contextFromTraceContext({
    traceparent,
    ...(tracestate ? { tracestate } : {}),
  });
}

export async function withHttpServerSpan<T>(
  method: string,
  route: string,
  headers: Record<string, string | string[] | undefined>,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  return withSpan(
    `HTTP ${method} ${route}`,
    {
      "http.request.method": method,
      "http.route": route,
      "server.address": "thechat-api",
    },
    fn,
    {
      kind: SpanKind.SERVER,
      parentContext: contextFromHeaders(headers),
      recordException: false,
    },
  );
}

export function setHttpResponseStatus(
  span: Span,
  status: number | string | undefined,
) {
  const parsed = typeof status === "number" ? status : Number(status ?? 200);
  if (!Number.isFinite(parsed)) return;
  span.setAttribute("http.response.status_code", parsed);
  if (parsed >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${parsed}` });
  }
}

function safeException(error: unknown) {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
      ? error.name
      : "Error";
  return { name, message: "operation_failed" };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
) {
  const value = Object.entries(headers).find(
    ([candidate]) => candidate.toLowerCase() === name,
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function resolveTraceEndpoint() {
  const explicit = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (explicit) return explicit;

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return null;
  return base.endsWith("/v1/traces")
    ? base
    : `${base.replace(/\/+$/, "")}/v1/traces`;
}

function parseResourceAttributes(value: string | undefined) {
  const attributes: Record<string, string> = {};
  if (!value) return attributes;

  for (const pair of value.split(",")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const attributeValue = pair.slice(separatorIndex + 1).trim();
    if (key && attributeValue) attributes[key] = attributeValue;
  }
  return attributes;
}
