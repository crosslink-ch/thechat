import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export const tracer = trace.getTracer("thechat-api");

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
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || defaultServiceName,
      "service.namespace": process.env.OTEL_SERVICE_NAMESPACE?.trim() || "thechat",
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

function resolveTraceEndpoint() {
  const explicit = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (explicit) return explicit;

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return null;
  return base.endsWith("/v1/traces") ? base : `${base.replace(/\/+$/, "")}/v1/traces`;
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
