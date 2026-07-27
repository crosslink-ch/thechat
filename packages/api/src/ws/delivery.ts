import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { WsServerEvent } from "@thechat/shared";
import { activeTraceContext, withSpan } from "../observability";

export interface WebSocketEventSender {
  send(data: string): void;
}

export interface WebSocketDeliveryResult {
  event: WsServerEvent;
  sent: number;
  failed: number;
}

export async function deliverWebSocketEvent(
  event: WsServerEvent,
  senders: WebSocketEventSender[],
): Promise<WebSocketDeliveryResult> {
  if (senders.length === 0) {
    return { event, sent: 0, failed: 0 };
  }

  return withSpan(
    "realtime.websocket.send",
    {
      "messaging.system": "thechat-websocket",
      "messaging.operation": "publish",
      "realtime.event.type": event.type,
      "realtime.socket_count": senders.length,
    },
    async (span) => {
      const traceContext = activeTraceContext();
      const propagated =
        event.type === "new_message" && traceContext
          ? { ...event, traceContext }
          : event;
      const data = JSON.stringify(propagated);
      let sent = 0;
      let failed = 0;
      for (const sender of senders) {
        try {
          sender.send(data);
          sent += 1;
        } catch {
          failed += 1;
        }
      }
      span.setAttribute("realtime.sent_count", sent);
      span.setAttribute("realtime.failed_count", failed);
      span.setAttribute(
        "realtime.delivery.outcome",
        failed === 0 ? "delivered" : sent > 0 ? "partial" : "failed",
      );
      if (failed > 0) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return { event: propagated, sent, failed };
    },
    { kind: SpanKind.PRODUCER, recordException: false },
  );
}
